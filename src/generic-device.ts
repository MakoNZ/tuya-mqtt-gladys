import type { MqttClient } from 'mqtt'
import type { DeviceConfig } from './types'
import { TuyaDevice } from './tuya-device'
import { log, logError } from './utils'

export class GenericDevice extends TuyaDevice {
  private haSubscriptions: string[] = []

  constructor(config: DeviceConfig, mqttClient: MqttClient, topicPrefix: string) {
    super(config, mqttClient, topicPrefix)
  }

  protected async init(): Promise<void> {
    if (this.config.template) {
      this.deviceTopics = this.config.template
    } else {
      try {
        await this.device.get({ schema: true })
      } catch {
        log('[tuya-mqtt] no schema or template for', this.config.id)
      }
    }

    this.publishHaDiscovery()

    if (Object.keys(this.deviceTopics).length > 0) {
      await this.getStates()
    }
  }

  protected publishHaDiscovery(): void {
    if (!this.config.template) {
      log('[tuya-mqtt] no template, skipping HA discovery for', this.deviceId)
      return
    }

    for (const [entityName, entry] of Object.entries(this.config.template)) {
      const component = this.getHaComponent(entry)
      const stateTopic = this.getHaStateTopic(entityName, entry)
      const commandTopic = this.getHaCommandTopic(entityName, entry)

      this.publishHaConfig(entityName, component, stateTopic, commandTopic, {
        ...entry,
        name: entityName,
      })

      if (commandTopic && !this.haSubscriptions.includes(commandTopic)) {
        this.haSubscriptions.push(commandTopic)
        this.mqttClient.subscribe(commandTopic, { qos: 1 }, (err) => {
          if (err) logError('[tuya-mqtt:error] subscribe failed', commandTopic, err.message)
        })
      }
    }

    // Publish climate discovery if configured
    if (this.config.climate) {
      this.publishHaClimateConfig()

      // Subscribe to climate command topics
      const modeCommandTopic = `homeassistant/climate/${this.deviceId}/climate/mode/set`
      this.mqttClient.subscribe(modeCommandTopic, { qos: 1 }, (err) => {
        if (err) logError('[tuya-mqtt:error] subscribe failed', modeCommandTopic, err.message)
      })

      const presetCommandTopic = `homeassistant/climate/${this.deviceId}/climate/preset/set`
      this.mqttClient.subscribe(presetCommandTopic, { qos: 1 }, (err) => {
        if (err) logError('[tuya-mqtt:error] subscribe failed', presetCommandTopic, err.message)
      })
    }

    this.mqttClient.subscribe(this.baseTopic + 'command', { qos: 1 })
  }

  processMqttMessage(topic: string, message: string): void {
    // Handle native Gladys MQTT API command topics:
    // gladys/device/{deviceId}/feature/{featureId}/state
    for (const entityName of Object.keys(this.deviceTopics)) {
      if (topic === this.getGladysCommandTopic(entityName)) {
        log(
          '[tuya-mqtt:command] Gladys command for',
          this.toString(),
          entityName,
          message,
        )
        this.handleHaCommand(entityName, message)
        return
      }
    }

    // Handle our clean device topics:
    // {topicPrefix}{deviceName}/{entity}/set
    if (topic.startsWith(this.baseTopic)) {
      if (topic === this.baseTopic + 'command' && message === 'get-states') {
        this.getStates()
        return
      }

      if (topic.endsWith('/set')) {
        const entityName = topic.slice(
          this.baseTopic.length,
          -'/set'.length,
        )

        if (entityName && this.deviceTopics[entityName]) {
          log('[tuya-mqtt:command] device command for', this.toString(), entityName, message)
          this.handleHaCommand(entityName, message)
          return
        }
      }
    }

    // Handle Home Assistant-style command topics:
    // homeassistant/{component}/{deviceId}/{entityName}/set
    const parts = topic.split('/')

    if (parts.length >= 5 && parts[0] === 'homeassistant') {
      const deviceId = parts[2]

      if (parts.length === 5 && deviceId === this.deviceId && parts[4] === 'set') {
        log('[tuya-mqtt:command] HA command for', this.toString(), parts[3], message)
        this.handleHaCommand(parts[3], message)
        return
      }

      // Handle climate commands:
      // homeassistant/climate/{deviceId}/climate/{type}/set
      if (
        parts.length === 6 &&
        deviceId === this.deviceId &&
        parts[3] === 'climate' &&
        parts[5] === 'set'
      ) {
        log('[tuya-mqtt:command] HA climate command for', this.toString(), parts[4], message)
        this.handleClimateCommand(parts[4], message)
        return
      }
    }
  }
}

export function createDevice(
  config: DeviceConfig,
  mqttClient: MqttClient,
  topicPrefix: string,
): TuyaDevice {
  return new GenericDevice(config, mqttClient, topicPrefix)
}
