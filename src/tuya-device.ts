import TuyAPI from 'tuyapi'
import type { MqttClient } from 'mqtt'
import type { DeviceConfig, TemplateEntry } from './types'
import { sleep, isJsonString, calc, log, logError } from './utils'

interface DpsValue {
  val: unknown
  updated: boolean
}

interface ColorState {
  h: number
  s: number
  b: number
}

export abstract class TuyaDevice {
  protected config: DeviceConfig
  protected mqttClient: MqttClient
  protected topicPrefix: string
  protected options: { id: string; key: string; ip?: string; version?: string; name?: string }
  protected device: TuyAPI
  protected dpsState: Record<number, DpsValue> = {}
  protected color: ColorState = { h: 0, s: 0, b: 0 }
  protected cmdColor: ColorState = { h: 0, s: 0, b: 0 }
  protected deviceTopics: Record<string, TemplateEntry> = {}
  protected connected = false
  protected reconnecting = false
  protected isRgbtwLight = false
  protected baseTopic: string
  protected deviceName: string
  protected readonly deviceId: string

  protected connectFailures = 0
  protected readonly maxBackoff = 300 // 5 minutes
  protected readonly maxConnectAttempts = 5 // recreate device after this many consecutive failures

  constructor(config: DeviceConfig, mqttClient: MqttClient, topicPrefix: string) {
    this.config = config
    this.mqttClient = mqttClient
    this.topicPrefix = topicPrefix
    this.deviceId = config.id

    this.options = {
      id: config.id,
      key: config.key,
    }

    if (config.name) {
      this.options.name = config.name.toLowerCase().replace(/[\s+#/]/g, '_')
    }
    if (config.ip) {
      this.options.ip = config.ip
      this.options.version = config.version || '3.1'
    }

    this.deviceName = config.name || config.id
    this.baseTopic = `${topicPrefix}${config.topic || this.options.name || config.id}/`

    this.device = new TuyAPI(JSON.parse(JSON.stringify(this.options)))
    this.setupEventListeners()
    this.connectDevice()
  }

  protected setupEventListeners(): void {
    this.device.on('dp-refresh', (raw) => {
      if (raw && typeof raw === 'object') {
        const data = raw as { dps?: Record<string, unknown> }

        if (data.dps) {
          log(
            '[tuya-mqtt] dp-refresh from',
            this.toString(),
            JSON.stringify(data.dps),
          )

          this.updateState(data.dps)
        }
      }
    })

    this.device.on('data', (raw) => {
      if (raw && typeof raw === 'object') {
        const data = raw as { dps?: Record<string, unknown> }
        if (data.dps) {
          log(
            '[tuya-mqtt] data from',
            this.toString(),
            JSON.stringify(data.dps),
          )
          this.updateState(data.dps)
        }
      } else {
        const msg = raw as string
        if (msg && msg !== 'json obj data unvalid') {
          log('[tuya-mqtt] string from', this.toString(), msg.replace(/[^a-zA-Z0-9 ]/g, ''))
        }
      }
    })

    this.device.on('connected', async () => {
      await sleep(1)
      if (this.device.isConnected()) {
        log('[tuya-mqtt] connected to', this.toString())
        this.connected = true
        this.connectFailures = 0 // Reset failure counter on successful connect
        this.init()
      }
    })

    this.device.on('disconnected', async () => {
      this.connected = false
      log('[tuya-mqtt] disconnected from', this.toString())
      await sleep(5)
      this.reconnect()
    })

    this.device.on('error', (err) => {
      logError('[tuya-mqtt:error]', this.toString(), err)
      sleep(1).then(() => this.reconnect())
    })
  }

  protected abstract init(): Promise<void>


  protected async getStates(): Promise<void> {
    this.connected = false
    for (const topicKey of Object.keys(this.deviceTopics)) {
      const key = this.deviceTopics[topicKey].key
      if (!this.dpsState[key]) {
        this.dpsState[key] = { val: undefined, updated: false }
      }
      try {
        const val = await this.device.get({ dps: key })
        this.dpsState[key] = { val, updated: true }
      } catch {
        logError('[tuya-mqtt:error] Could not get DPS key', key)
      }
    }
    this.connected = true
    this.publishTopics()
  }

  updateState(dps: Record<string, unknown>): void {
    if (!dps) return

    for (const keyStr of Object.keys(dps)) {
      const key = Number(keyStr)
      const val = dps[keyStr]
      if (this.dpsState[key]?.val !== val) {
        this.dpsState[key] = { val, updated: true }
      }

      if (this.isRgbtwLight) {
        const dpsColorKey = this.config.dpsColor
        const dpsModeKey = this.config.dpsMode
        if (dpsColorKey && dpsColorKey === key) {
          this.updateColorState(val as string)
        } else if (dpsModeKey && dpsModeKey === key && this.config.dpsColor) {
          this.dpsState[this.config.dpsColor].updated = true
        }
      }
    }

    if (this.connected) this.publishTopics()
  }

  publishTopics(): void {
    if (!this.connected) return

      for (const topicKey of Object.keys(this.deviceTopics)) {
        const entry = this.deviceTopics[topicKey]
        const key = entry.key

        if (this.dpsState[key]?.updated) {
          const state = this.getTopicState(entry, this.dpsState[key].val)

          if (state !== null) {
            // Neutral MQTT state topic
            const stateTopic = this.getStateTopic(topicKey, entry)
            this.mqttClient.publish(stateTopic, state, {
              retain: true,
              qos: 1,
            })

            // Native Gladys MQTT API topic
            let gladysState: string | null

            if (topicKey === 'color_temp') {
              const kelvin = Number(state)

              const mired = this.kelvinToGladysColorTemp(
                kelvin,
                entry,
              )

              gladysState =
                mired === null
                  ? null
                  : String(Math.round(mired))
            } else {
              gladysState = this.getGladysState(
                entry,
                this.dpsState[key].val,
              )
            }

            if (gladysState !== null) {
              const gladysTopic = this.getGladysStateTopic(topicKey)

              this.mqttClient.publish(gladysTopic, gladysState, {
                retain: true,
                qos: 1,
              })
            }

            this.dpsState[key].updated = false
          }
        }
      }

      this.publishDpsTopics()
  }

  publishDpsTopics(): void {
    const data: Record<string, unknown> = {}
    for (const key of Object.keys(this.dpsState)) {
      if (this.dpsState[Number(key)]?.updated) {
        data[key] = this.dpsState[Number(key)].val
      }
    }

    if (Object.keys(data).length > 0) {
      this.mqttClient.publish(this.baseTopic + 'dps/state', JSON.stringify(data), { retain: false, qos: 1 })
    }
  }

  protected getStateTopic(entityName: string, entry: TemplateEntry): string {
    return `${this.baseTopic}${entityName}/state`
  }

  protected getCommandTopic(entityName: string, entry: TemplateEntry): string | undefined {
    if (entry.type === 'float' || entry.type === 'int') {
      if (entry.topicMin === undefined && entry.topicMax === undefined) return undefined
    }
    if (entry.type === 'str' && !entry.options) return undefined
    return `${this.baseTopic}${entityName}/set`
  }

  protected getGladysDeviceId(): string {
    const slug = this.config.topic || this.options.name || this.config.id
    const gladysSlug = slug
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')

    return `mqtt:${gladysSlug}`
  }

  protected getGladysFeatureId(entityName: string): string {
    const featureSlug = entityName
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')

    return `${this.getGladysDeviceId()}:${featureSlug}`
  }

  protected getGladysStateTopic(entityName: string): string {
    return `gladys/master/device/${this.getGladysDeviceId()}/feature/${this.getGladysFeatureId(entityName)}/state`
  }

  protected getGladysCommandTopic(entityName: string): string {
    return `gladys/device/${this.getGladysDeviceId()}/feature/${this.getGladysFeatureId(entityName)}/state`
  }

  private static readonly GLADYS_COLOR_TEMP_MIN_MIRED = 153
  private static readonly GLADYS_COLOR_TEMP_MAX_MIRED = 500

  protected gladysColorTempToKelvin(
    value: number,
    entry: TemplateEntry,
  ): number | null {
    if (
      entry.topicMin === undefined ||
      entry.topicMax === undefined ||
      isNaN(value)
    ) {
      return null
    }

    const gladysMin = TuyaDevice.GLADYS_COLOR_TEMP_MIN_MIRED
    const gladysMax = TuyaDevice.GLADYS_COLOR_TEMP_MAX_MIRED

    const deviceWarmKelvin = entry.topicMin
    const deviceCoolKelvin = entry.topicMax

    const clamped = Math.max(gladysMin, Math.min(gladysMax, value))

    const ratio =
      (clamped - gladysMin) /
      (gladysMax - gladysMin)

    const deviceCoolMired = 1000000 / deviceCoolKelvin
    const deviceWarmMired = 1000000 / deviceWarmKelvin

    const deviceMired =
      deviceCoolMired +
      ratio * (deviceWarmMired - deviceCoolMired)

    return 1000000 / deviceMired
  }

  protected kelvinToGladysColorTemp(
    kelvin: number,
    entry: TemplateEntry,
  ): number | null {
    if (
      entry.topicMin === undefined ||
      entry.topicMax === undefined ||
      isNaN(kelvin)
    ) {
      return null
    }

    const gladysMin = TuyaDevice.GLADYS_COLOR_TEMP_MIN_MIRED
    const gladysMax = TuyaDevice.GLADYS_COLOR_TEMP_MAX_MIRED

    const deviceWarmKelvin = entry.topicMin
    const deviceCoolKelvin = entry.topicMax

    const clamped = Math.max(
      deviceWarmKelvin,
      Math.min(deviceCoolKelvin, kelvin),
    )

    const deviceWarmMired = 1000000 / deviceWarmKelvin
    const deviceCoolMired = 1000000 / deviceCoolKelvin
    const currentMired = 1000000 / clamped

    const ratio =
      (currentMired - deviceCoolMired) /
      (deviceWarmMired - deviceCoolMired)

    return gladysMin + ratio * (gladysMax - gladysMin)
  }

  protected getGladysState(
    entry: TemplateEntry,
    value: unknown,
  ): string | null {
    if (value === undefined || value === null) {
      return null
    }

    if (entry.type === 'bool') {
      return Boolean(value) ? '1' : '0'
    }

    if (entry.type === 'int' || entry.type === 'float') {
      return this.parseNumberState(Number(value), entry)
    }

    return null
  }

  protected getTopicState(entry: TemplateEntry, value: unknown): string | null {
    if (value === undefined || value === null) return null

    switch (entry.type) {
      case 'bool':
        return value ? 'ON' : 'OFF'
      case 'int':
      case 'float':
        return this.parseNumberState(Number(value), entry)
      case 'hsb':
      case 'hsbhex': {
        const components = (entry.components || 'h,s,b').split(',')
        return components.map(c => {
          if (c === 's' && this.isRgbtwLight && this.config.dpsMode &&
              this.dpsState[this.config.dpsMode]?.val === 'white') {
            return '0'
          }
          return String(this.color[c as keyof ColorState])
        }).join(',')
      }
      case 'str':
        return String(value || '')
      default:
        return String(value)
    }
  }

  protected parseNumberState(value: number, entry: TemplateEntry): string | null {
    if (isNaN(value)) return null
    if (entry.stateMath) {
      value = entry.type === 'int'
        ? Math.round(calc(`${value}${entry.stateMath}`))
        : calc(`${value}${entry.stateMath}`)
    }
    return String(value)
  }

  processCommand(message: string, commandTopic: string): void {
    const parsed = isJsonString(message)
    const command = parsed ? JSON.parse(message) : message.toLowerCase()

    if (commandTopic === 'command' && command === 'get-states') {
      this.getStates()
    } else {
      this.processDeviceCommand(command, commandTopic)
    }
  }

  processDeviceCommand(command: unknown, commandTopic: string): void {
    const stateTopic = commandTopic.replace('/set', '/state')
    const entityName = Object.keys(this.deviceTopics).find(
      k => this.getStateTopic(k, this.deviceTopics[k]) === stateTopic ||
           (this.getCommandTopic(k, this.deviceTopics[k]) === commandTopic)
    )

    if (!entityName) {
      log('[tuya-mqtt:command] unknown topic', commandTopic)
      return
    }

    this.handleDeviceCommand(entityName, String(command))
  }

  handleDeviceCommand(entityName: string, message: string): void {
    const entry = this.deviceTopics[entityName]
    if (!entry) {
      log('[tuya-mqtt:command] unknown entity', entityName)
      return
    }

    // Gladys colour-temperature commands use mireds,
    // while our Tuya template uses the device's native Kelvin range.
    if (entityName === 'color_temp' && entry.type === 'int') {
      const mired = Number(message)

      const kelvin = this.gladysColorTempToKelvin(
        mired,
        entry,
      )

      if (kelvin !== null) {
        log(
          '[tuya-mqtt:command] Gladys color-temp',
          mired,
          'mired ->',
          Math.round(kelvin),
          'K',
        )

        this.sendTuyaCommand(String(kelvin), entry)
        return
      }

      log(
        '[tuya-mqtt:command] invalid Gladys color temperature',
        message,
      )
      return
    }

    this.sendTuyaCommand(message, entry)
  }

  sendTuyaCommand(message: string, entry: TemplateEntry): void {
    let setVal: string | number | boolean | '!!!INVALID!!!'

    switch (entry.type) {
      case 'bool': {
        const msg = message.toLowerCase()
        if (msg === 'toggle') {
          setVal = !Boolean(this.dpsState[entry.key]?.val)
        } else {
          setVal = msg === 'on' || msg === '1' || msg === 'true'
        }
        break
      }
      case 'int':
      case 'float':
        setVal = this.parseNumberCommand(message, entry)
        break
      case 'hsb':
        this.updateCommandColor(message, entry.components || 'h,s,b')
        setVal = this.parseTuyaHsbColor()
        break
      case 'hsbhex':
        this.updateCommandColor(message, entry.components || 'h,s,b')
        setVal = this.parseTuyaHsbHexColor()
        break
      default:
        setVal = message
    }

    if (setVal === '!!!INVALID!!!') {
      log('[tuya-mqtt:command] invalid value', message)
      return
    }

    this.set({ dps: entry.key, set: setVal })
  }

  protected parseNumberCommand(message: string, entry: TemplateEntry): number | '!!!INVALID!!!' {
    const value = Number(message)
    if (isNaN(value)) return '!!!INVALID!!!'

    let clamped = value
    if (entry.topicMin !== undefined && value < entry.topicMin) {
      clamped = entry.topicMin
    }
    if (entry.topicMax !== undefined && value > entry.topicMax) {
      clamped = entry.topicMax
    }

    if (entry.commandMath) {
      return entry.type === 'int'
        ? Math.round(calc(`${clamped}${entry.commandMath}`))
        : calc(`${clamped}${entry.commandMath}`)
    }

    return entry.type === 'int' ? Math.round(clamped) : clamped
  }

  processDpsCommand(message: string): void {
    const parsed = isJsonString(message)
    if (parsed) {
      const command = parsed as { dps?: number; set?: unknown; multiple?: boolean; data?: Record<string, unknown> }
      if (command.multiple && command.data) {
        for (const key of Object.keys(command.data)) {
          this.device.set({ dps: Number(key), set: command.data[key] as string | number | boolean })
        }
      } else if (command.dps !== undefined) {
        this.set(command as { dps: number; set: string | number | boolean })
      }
    } else {
      log('[tuya-mqtt:command] DPS topic requires JSON')
    }
  }

  processDpsKeyCommand(message: string, dpsKey: number): void {
    if (isJsonString(message)) {
      log('[tuya-mqtt:command] DPS key topics do not accept JSON')
    } else {
      this.set({ dps: dpsKey, set: this.parseDpsMessage(message) })
    }
  }

  parseDpsMessage(message: string): boolean | number | string {
    if (message === 'true') return true
    if (message === 'false') return false
    if (!isNaN(Number(message))) return Number(message)
    return message
  }

  set(command: { dps: number; set: string | number | boolean }): void {
    log('[tuya-mqtt] set', this.toString(), JSON.stringify(command))
    this.device.set(command).catch((err: Error) => logError('[tuya-mqtt:error] set failed', this.toString(), err.message))
  }

  protected updateColorState(value: string): void {
    let h: number, s: number, b: number
    if (this.config.colorType === 'hsbhex') {
      const match = (value || '0000000000ffff').match(/^.{6}([0-9a-f]{4})([0-9a-f]{2})([0-9a-f]{2})$/i)
      h = parseInt(match?.[1] || '0', 16)
      s = Math.round(parseInt(match?.[2] || 'ff', 16) / 2.55)
      b = Math.round(parseInt(match?.[3] || 'ff', 16) / 2.55)
    } else {
      const match = (value || '000003e803e8').match(/^([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})$/i)
      h = parseInt(match?.[1] || '0', 16)
      s = Math.round(parseInt(match?.[2] || '3e8', 16) / 10)
      b = Math.round(parseInt(match?.[3] || '3e8', 16) / 10)
    }
    this.color = { h, s, b }
    if (!this.cmdColor) {
      this.cmdColor = { h, s, b }
    }
  }

  protected updateCommandColor(value: string, components: string): void {
    const comps = components.split(',')
    const values = value.split(',')
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i]
      if (c === 'h' || c === 's' || c === 'b') {
        this.cmdColor[c] = Math.round(Number(values[i]))
      }
    }
  }

  protected parseTuyaHsbColor(): string {
    const { h, s, b } = this.cmdColor
    return h.toString(16).padStart(4, '0') +
      (10 * s).toString(16).padStart(4, '0') +
      (10 * b).toString(16).padStart(4, '0')
  }

  protected parseTuyaHsbHexColor(): string {
    const { h, s, b } = this.cmdColor
    const hsb = h.toString(16).padStart(4, '0') +
      Math.round(2.55 * s).toString(16).padStart(2, '0') +
      Math.round(2.55 * b).toString(16).padStart(2, '0')

    const hNorm = h / 60
    const sNorm = s / 100
    const bNorm = b * 2.55
    const i = Math.floor(hNorm)
    const f = hNorm - i
    const p = bNorm * (1 - sNorm)
    const q = bNorm * (1 - sNorm * f)
    const t = bNorm * (1 - sNorm * (1 - f))

    let rgb: number[]
    switch (i % 6) {
      case 0: rgb = [bNorm, t, p]; break
      case 1: rgb = [q, bNorm, p]; break
      case 2: rgb = [p, bNorm, t]; break
      case 3: rgb = [p, q, bNorm]; break
      case 4: rgb = [t, p, bNorm]; break
      case 5: rgb = [bNorm, p, q]; break
      default: rgb = [0, 0, 0]
    }

    const hex = rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('')
    return hex + hsb
  }

  protected async connectDevice(): Promise<void> {
    log('[tuya-mqtt] searching for', this.toString())
    try {
      await this.device.find()
      log('[tuya-mqtt] found', this.toString())
      try {
        await this.device.connect()
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logError('[tuya-mqtt:error]', msg)
        this.reconnect()
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logError('[tuya-mqtt:error]', msg)
      log('[tuya-mqtt] retry in 60s')
      await sleep(60)
      this.connectDevice()
    }
  }

  protected async reconnect(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true

    this.connected = false

    this.connectFailures++

    // Exponential backoff: 10s, 20s, 40s, 80s, 160s, 300s (cap)
    const backoff = Math.min(10 * Math.pow(2, this.connectFailures - 1), this.maxBackoff)
    log(
      '[tuya-mqtt] reconnecting', this.toString(),
      `(attempt ${this.connectFailures}, waiting ${backoff}s)`,
    )

    // Disconnect old device to flush stale TCP state
    try { this.device.disconnect() } catch { /* ignore */ }

    await sleep(backoff)

    // After several consecutive failures, recreate the TuyAPI instance
    // This fully resets the TCP/socket state — the root fix for ECONNRESET loops
    if (this.connectFailures > this.maxConnectAttempts) {
      log('[tuya-mqtt] recreating device object for', this.toString(),
        '(too many connection failures)')
      this.device.removeAllListeners()
      this.device = new TuyAPI(JSON.parse(JSON.stringify(this.options)))
      this.setupEventListeners()
      this.connectFailures = 0 // restarted with fresh state
    }

    this.connectDevice().finally(() => {
      this.reconnecting = false
    })
  }

  disconnect(): void {
    this.device.disconnect()
  }

  toString(): string {
    return this.config.name + ' (' + (this.config.ip ? this.config.ip + ', ' : '') + this.options.id + ')'
  }
}
