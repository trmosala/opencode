import { paths, type IconName } from "../../app/src/components/cm3-icons/paths"

export function icon(name: IconName, size = 18) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="${size}" height="${size}" fill="currentColor" aria-hidden="true" focusable="false" data-component="cm3-icon" data-cm3-icon="${name}"><path d="${paths[name]}"/></svg>`
}
