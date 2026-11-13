export type RGB = [number, number, number]
export type HSV = { hue: number; saturation: number; brightness: number }

export function readHexColour(value: string): RGB | undefined {
  const digits = value.trim().replace(/^#/, '')
  if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(digits)) return
  const hex = digits.length === 3 ? Array.from(digits, digit => digit + digit).join('') : digits
  return [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16)) as RGB
}

export function readRGBChannels(channels: readonly string[]): RGB | undefined {
  if (channels.length !== 3 || channels.some(channel => !/^\d{1,3}$/.test(channel) || Number(channel) > 255)) return
  return channels.map(Number) as RGB
}

export function toHexColour(rgb: RGB) {
  return '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('')
}

export function toHSV([red, green, blue]: RGB, previousHue = 0): HSV {
  const max = Math.max(red, green, blue)
  const delta = max - Math.min(red, green, blue)
  let hue = previousHue
  if (delta) {
    const sector = max === red ? (green - blue) / delta : max === green ? 2 + (blue - red) / delta : 4 + (red - green) / delta
    hue = (sector * 60 + 360) % 360
  }
  return { hue, saturation: max ? delta / max : 0, brightness: max / 255 }
}

export function toRGB({ hue, saturation, brightness }: HSV): RGB {
  const channel = (offset: number) => {
    const position = (offset + hue / 60) % 6
    return Math.round(brightness * (1 - saturation * Math.max(0, Math.min(position, 4 - position, 1))) * 255)
  }
  return [channel(5), channel(3), channel(1)]
}

export function readableInk(colour: string) {
  const rgb = readHexColour(colour)
  if (!rgb) return undefined
  const [r, g, b] = rgb.map(value => {
    const channel = value / 255
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
  })
  return .2126 * r + .7152 * g + .0722 * b > .179 ? '#000' : '#fff'
}
