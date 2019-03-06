import { encode, decode } from '@spectacles/util';
import * as amqp from 'amqplib';
import { ulid } from 'ulid';
const { isFatalError } = require('amqplib/lib/connection');
import Broker from './Base';
import { EventEmitter } from 'events';

export interface AmqpOptions {
  rpc?: boolean;
  reconnectTimeout?: number;
  consume?: amqp.Options.Consume,
  assert?: amqp.Options.AssertQueue,
}

/**
 * A broker for AMQP clients. Probably most useful for RabbitMQ.
 * @extends Broker
 */
export default class Amqp extends Broker {
  /**
   * The AMQP channel currently connected to.
   * @type {?amqp.Channel}
   */
  public channel?: amqp.Channel = undefined;

  /**
   * The callback queue.
   * @type {?string}
   */
  public callback?: string;

  /**
   * The AMQP exchange of this broker.
   * @type {string}
   */
  public group: string = '';

  /**
   * The subgroup of this broker. Useful to setup multiple groups of queues that all receive the same data.
   * Implemented internally as an extra identifier in the queue name.
   * @type {string}
   */
  public subgroup: string = '';

  public options: AmqpOptions;

  /**
   * The consumers that this broker has registered.
   * @type {Object<string, string>}
   * @private
   */
  private _consumers: { [event: string]: string } = {};

  /**
   * RPC responses this broker receives.
   * @type {EventEmitter}
   * @private
   */
  private _responses: EventEmitter = new EventEmitter();

  /**
   * @constructor
   * @param {Client} client The client of this broker
   * @param {string} [group='default'] The group of this broker
   * @param {string} [subgroup] The {@link Amqp#subgroup} of this broker
   * @param {Object} [options={}] Options for constructing this broker
   * @param {boolean} [options.rpc=false] Whether this broker is in RPC mode (causes the {@link Amqp#publish}
   * method to wait for a response before resolving)
   * @param {number} [options.reconnectTimeout=1e4] How often to attempt to reconnect when the connection fails.
   */
  constructor(group: string, options?: AmqpOptions);
  constructor(group: string, subgroup: string, options?: AmqpOptions);
  constructor(group: string = 'default', subgroup?: AmqpOptions | string, options: AmqpOptions = {}) {
    super();
    this.group = group;

    if (typeof subgroup === 'object') options = subgroup;
    else if (typeof subgroup === 'string') this.subgroup = subgroup;

    this.options = options;
  }

  /**
   * Connect this broker to your AMQP client.
   * @param {string} url The URL of your AMQP client
   * @param {?*} options Options to connect to the AMQP client
   * @returns {Promise<void>}
   */
  public async connect(urlOrConn: string | amqp.Connection, options?: any): Promise<amqp.Connection> {
    let connection: amqp.Connection | undefined;
    if (typeof urlOrConn !== 'string') connection = urlOrConn;

    while (!connection) {
      try {
        connection = await amqp.connect(`amqp://${urlOrConn}`, options);
      } catch (e) {
        this.emit('close', e);
        await new Promise(r => setTimeout(r, this.options.reconnectTimeout));
        continue;
      }

      connection.on('close', (err) => {
        if (!isFatalError(err)) {
          this.emit('close', err);
          setTimeout(() => this.connect(urlOrConn, options), this.options.reconnectTimeout);
        }
      });

      connection.on('error', (err) => {
        this.emit('error', err);
      });
    }

    this.channel = await connection.createChannel();

    // setup RPC callback queue
    this.callback = (await this.channel.assertQueue('', { exclusive: true, durable: false })).queue;
    this.channel.consume(this.callback, (msg) => {
      if (msg) this._responses.emit(msg.properties.correlationId, decode(msg.content));
    }, { noAck: true, durable: false });

    await this.channel.assertExchange(this.group, 'direct', { durable: false });
    return connection;
  }

  /**
   * Subscribe this broker to some AMQP queues.
   * @param {string|Iterable<string>} events The events to subscribe to
   * @param {Object} [options={}] The connection options
   * @param {amqp.Options.Consume} [options.consume] Options to pass to the consumer
   * @param {amqp.Options.AssertQueue} [options.assert] Options to pass to the queue assertion
   * @returns {Promise<amqp.Replies.Consume[]>}
   */
  public async subscribe(events: string | string[]): Promise<amqp.Replies.Consume[]> {
    if (!Array.isArray(events)) events = [events];

    return Promise.all(events.map(async event => {
      // setup queue
      const queue = `${this.group}:${(this.subgroup && `${this.subgroup}:`) + event}`;
      await this._channel.assertQueue(queue, this.options.assert);
      await this._channel.bindQueue(queue, this.group, event);

      // register consumer
      const consumer = await this._channel.consume(queue, msg => {
        // emit consumed messages with an acknowledger function
        if (msg) {
          this.emit(event, decode(msg.content), {
            reply: (response: any = null) => this._channel.sendToQueue(msg.properties.replyTo, encode(response), { correlationId: msg.properties.correlationId }),
            ack: () => this._channel.ack(msg),
            nack: (allUpTo?: boolean, requeue?: boolean) => this._channel.nack(msg, allUpTo, requeue),
            reject: (requeue?: boolean) => this._channel.reject(msg, requeue),
          });
        }
      }, this.options.consume);

      this._consumers[event] = consumer.consumerTag;
      return consumer;
    }));
  }

  /**
   * Unsubscribe this broker from some AMQP queues.
   * @param {string | string[]} events The channels to unsubscribe from
   * @returns {Promise<Array<undefined>>}
   */
  public async unsubscribe(events: string | string[]): Promise<boolean[]> {
    if (!Array.isArray(events)) events = [events];
    return Promise.all(events.map(async event => {
      if (this._consumers[event]) {
        await this._channel.cancel(this._consumers[event]);
        delete this._consumers[event];
        return true;
      }

      return false;
    }))
  }

  /**
   * Publish an event to the AMQP broker.
   * @param {string} event The event to publish
   * @param {*} data The data to publish
   * @param {amqp.Options.Publish} [options={}] AMQP publish options
   */
  public publish(event: string, data: any, options: amqp.Options.Publish = {}): Promise<any | void> {
    const correlation = ulid();
    this._channel.publish(this.group, event, encode(data), Object.assign(options || {}, {
      replyTo: this.callback,
      correlationId: correlation,
    }));

    if (!this.options.rpc) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timer | undefined;

      if (options && options.expiration) {
        timeout = setTimeout(() => {
          this._responses.removeListener(correlation, listener);
          reject(new Error('AMQP callback exceeded time limit'));
        }, Number(options.expiration));
      }

      const listener = (response: any) => {
        if (timeout) clearTimeout(timeout);
        resolve(response);
      };

      this._responses.once(correlation, listener);
    });
  }

  /**
   * Convenience accessor for the AMQP channel.
   * @throws {Error} When the channel doesn't exist
   * @returns {amqp.Channel} The AMQP channel.
   * @protected
   */
  protected get _channel(): amqp.Channel {
    if (!this.channel) throw new Error('no available amqp channel');
    return this.channel;
  }
}
