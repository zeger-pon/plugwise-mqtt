import {connect, MqttClient} from 'mqtt'

import {logger} from '../logger'
import {plugwiseConfig, isCompleteMessageTemplate} from '../config'
import {
  failedClosingConnectionsError,
  publishingError,
  connectError,
  subscribeError,
} from './error'

import type {
  actionTopic,
  actionGroup,
  statusTopic,
  topicTemplate,
} from '../../types/config'
import type {plugwiseMqttMessage, statusMqttMessage} from '../../types/mqtt'

import {template} from '../helpers'

import Plugwise from '../plugwise'
import {exit} from 'process'

/**
 * MQTT handling
 */
export default class Mqtt {
  private static instance: Mqtt
  private mqttClient: MqttClient
  private plugwise: Plugwise

  private actionTopicLookup: {
    [index: string]: {actionType: string; actionTopicConfig: actionTopic}
  } = {}

  /**
   * Connect to the main mqtt gateway - no support yet
   * for multiple mqtt gateways
   */
  public constructor() {
    this.plugwise = Plugwise.getInstance()

    logger.info({
      msg: 'Connecting to MQTT server',
      server: plugwiseConfig.mqtt.server,
      port: plugwiseConfig.mqtt.port,
    })

    this.mqttClient = connect(plugwiseConfig.mqtt.server, {
      port: plugwiseConfig.mqtt.port,
      keepalive: 3600,
    }).on('error', function (err) {
      /**
       * No connection to MQTT server, nothing to do
       */
      logger.error(connectError(err))
      exit(1)
    })

    /**
     * Bind to this object, otherwise the "this" refers to the
     * MQTT client and we cannot reach the Plugwise class
     */
    this.mqttClient
      .on('connect', this.onConnect.bind(this))
      .on('message', this.onMessage.bind(this))
  }

  /**
   * Singleton pattern
   *
   * @return {Mqtt}
   */
  static getInstance(): Mqtt {
    if (!Mqtt.instance) {
      Mqtt.instance = new Mqtt()
    }

    return Mqtt.instance
  }

  /**
   * Connect to the sensor actions topics in order to convert the
   * MQTT message to an update to Plugwise
   */
  private onConnect() {
    const mqttClient = this.mqttClient
    const actionTopicLookup = this.actionTopicLookup
    let mqttActionTopicListen: string

    logger.info({
      mqtt_status: 'connected',
      mqtt_server: plugwiseConfig.mqtt.server,
      mqtt_port: plugwiseConfig.mqtt.port,
    })

    plugwiseConfig.mqtt.topics.action &&
      Object.values(plugwiseConfig.mqtt.topics.action).reduce(function (
        _accumulator: any,
        group: actionGroup,
      ) {
        Object.keys(group).reduce(function (
          _accumulator: any,
          actionType: string,
        ) {
          const topics = group[actionType]
          /**
           * Create the lookup for the message received function
           */
          actionTopicLookup[topics.listen] = {
            actionType: actionType,
            actionTopicConfig: topics,
          }
          ;[topics.listen, topics.status].reduce(function (
            _accumulator: any,
            topic: string,
          ) {
            mqttClient.subscribe(
              topic.replace(/\{[a-zA-Z]+\}/g, '+'),
              function (err, granted) {
                if (err) {
                  logger.error(
                    subscribeError(err, {topic: mqttActionTopicListen}),
                  )
                } else {
                  logger.info({
                    msg: 'MQTT subscribed',
                    granted,
                    topic: mqttActionTopicListen,
                  })
                }
              },
            )
          },
          [])
        },
        [])
      },
      [])
  }

  /**
   * Incoming messages handling, such as temperature settigns
   *
   * @param {string} topic
   * @param {string} rawMessage
   */
  private onMessage(topic: string, rawMessage: string) {
    const message = rawMessage.toString()
    const plugwise = this.plugwise
    const mqttClient = this.mqttClient

    let actionTopicConfig: {actionType: string; actionTopicConfig: actionTopic}

    logger.debug({msg: 'mqtt message received', topic, message})

    /**
     * Figure out which topic it actually was from the list of
     * action topics
     */
    if (
      (actionTopicConfig = this.actionTopicLookup[
        topic.replace(/[a-z0-9]{32}/, '{applianceId}')
      ])
    ) {
      logger.info({
        msg: 'action topic match',
        actionTopicConfig,
        topic,
        rawMessage,
      })

      /**
       * Fetch the applianceId from the topic
       *
       * Example: gBridge/u1/3a19bccef5982bde990632fd4f5894d4/thermostat
       */
      const applianceMatch = topic.match(/[a-z0-9]{32}/g)

      if (applianceMatch) {
        const applianceId: string = applianceMatch[0]
        const statusTopic: string = template(
          actionTopicConfig.actionTopicConfig.status,
          {applianceId: applianceId},
        )

        switch (actionTopicConfig.actionType) {
          case 'thermostat':
            /**
             * Update the thermostat in plugwise, if successfull update the
             * the status topic
             */
            if (plugwise.setThermostat(applianceId, parseFloat(message))) {
              mqttClient.publish(statusTopic, message)
            } else {
              /**
               * Not really a publishing error @todo
               */
              logger.error(
                publishingError(new Error('Error setting thermostat'), {
                  topic,
                  actionTopicConfig,
                  message: rawMessage,
                }),
              )
            }

            break

          case 'scene':
            /**
             * Scene handling is a bit tricky, Google Home has limited
             * options (Off, Heat etc) for now just mirror the change as
             * send by Google Home - if we do not mirror the change in the
             * status topic the thermostat setting will be "stuck"
             */
            mqttClient.publish(statusTopic, message)
            break
        }
      } else {
        logger.error(
          'No appliance found in action topic - cannot handle message',
        )
      }
    }
  }

  /**
   * Publish the status of the tool
   *
   * @param {statusMqttMessage} statusMessage
   */
  public status(statusMessage: statusMqttMessage) {
    const mqttClient = this.mqttClient

    plugwiseConfig.mqtt.topics.status &&
      Object.values(plugwiseConfig.mqtt.topics.status).reduce(function (
        _accumulator: any,
        topicConfig: statusTopic,
      ) {
        mqttClient.publish(
          topicConfig.topic,
          JSON.stringify(statusMessage),
          {},
          (err: any) =>
            err &&
            logger.error(
              publishingError(err, {
                topic: topicConfig.topic,
                message: statusMessage,
              }),
            ),
        )
      },
      [])
  }

  /**
   * Publish the list of plugwise messages to one or multiple topics
   *
   * @param {plugwiseMqttMessage[]} mqttMessages
   */
  public publish(mqttMessages: plugwiseMqttMessage[]) {
    const self = this

    logger.info(`${mqttMessages.length} message(s) ready to send`)

    mqttMessages.length &&
      mqttMessages.reduce(function (
        _accumulator: any,
        mqttMessage: plugwiseMqttMessage,
      ) {
        /**
         * Loop through the array of data (output) topics - so each
         * message can be published multiple times
         */
        plugwiseConfig.mqtt.topics.data &&
          Object.values(plugwiseConfig.mqtt.topics.data).reduce(function (
            _accumulator: any,
            topicConfig: topicTemplate,
          ) {
            const topic = template(topicConfig.topic, {
              applianceId: mqttMessage.id,
              ...mqttMessage,
            })

            /**
             * The message is a simple template with one exception to
             * dump the whole message to MQTT using the
             * MQTT_MESSAGE_COMPLETE keyword
             *
             * We add one extra value to the template "applianceId" -
             * for easy of use
             */
            // prettier-ignore
            const message =
              isCompleteMessageTemplate(topicConfig.message)
                ? mqttMessage
                : template(topicConfig.message, {
                  applianceId: mqttMessage.id,
                  ...mqttMessage,
                })

            if (!plugwiseConfig.mqtt.dryRun) {
              logger.debug({msg: 'publishing', topic, message})

              self.mqttClient.publish(
                topic,
                JSON.stringify(message),
                {},
                (err: any) =>
                  err && logger.error(publishingError(err, {topic, message})),
              )
            } else {
              logger.info({
                msg: 'dry run enabled; not publishing',
                topic,
                message,
              })
            }
          },
          [])
      },
      [])
  }

  /**
   * Close the connections and stop
   *
   * @return {Promise}
   */
  public shutdown(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.mqttClient.end(false, function (result: boolean | undefined) {
        if (result == null) {
          logger.info('MQTT connections closed')
          resolve()
        } else {
          const error = failedClosingConnectionsError()
          logger.error(error)
          reject(error)
        }
      })
    })
  }
}