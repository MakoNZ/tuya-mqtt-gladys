import type { MqttClient } from 'mqtt'
import type { DeviceConfig } from './types'
import { TuyaDevice } from './tuya-device'
import { log } from './utils'

export class GenericDevice extends TuyaDevice {

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


    if (Object.keys(this.deviceTopics).length > 0) {
      await this.getStates()
    }
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
        this.handleDeviceCommand(entityName, message)
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
          this.handleDeviceCommand(entityName, message)
          return
        }
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
