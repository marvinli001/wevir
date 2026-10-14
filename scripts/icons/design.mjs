import { readFileSync } from 'node:fs';

export const geometry = readFileSync(
  new URL('../../assets/icons/source/mark.svg', import.meta.url),
  'utf8',
).match(/<path d="([^"]+)"/)[1];
export const modes = JSON.parse(
  readFileSync(new URL('../../assets/icons/source/palette.json', import.meta.url), 'utf8'),
);

export function defs() {
  return `<defs>
  <linearGradient id="platinum" x1="0" y1="0" x2="1" y2=".85"><stop stop-color="#FFFFF9"/><stop offset=".18" stop-color="#D8DCDE"/><stop offset=".32" stop-color="#FAFBF8"/><stop offset=".48" stop-color="#A5AAAE"/><stop offset=".61" stop-color="#D1D5D7"/><stop offset=".77" stop-color="#FFFFFF"/><stop offset="1" stop-color="#C5C7C6"/></linearGradient>
  <linearGradient id="platinum-rim" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="#FFFFFF"/><stop offset=".4" stop-color="#CED1D2"/><stop offset=".62" stop-color="#858A90"/><stop offset="1" stop-color="#F0F1EB"/></linearGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="1" y2=".85"><stop stop-color="#F7E8BC"/><stop offset=".18" stop-color="#E1C694"/><stop offset=".36" stop-color="#FFF0C9"/><stop offset=".51" stop-color="#A78752"/><stop offset=".66" stop-color="#CBAA73"/><stop offset=".82" stop-color="#F0DBAC"/><stop offset="1" stop-color="#B4935C"/></linearGradient>
  <linearGradient id="gold-rim" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="#FAEBC5"/><stop offset=".45" stop-color="#B08C50"/><stop offset=".7" stop-color="#EFDCB0"/><stop offset="1" stop-color="#8F703E"/></linearGradient>
  <linearGradient id="obsidian" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#343533"/><stop offset=".24" stop-color="#101210"/><stop offset=".4" stop-color="#282A27"/><stop offset=".62" stop-color="#090B09"/><stop offset=".8" stop-color="#242521"/><stop offset="1" stop-color="#10120F"/></linearGradient>
  <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#303238"/><stop offset=".35" stop-color="#202228"/><stop offset=".7" stop-color="#14161A"/><stop offset="1" stop-color="#22242A"/></linearGradient>
  <linearGradient id="tile-warm" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#F9F8F3"/><stop offset=".35" stop-color="#F4F3ED"/><stop offset=".72" stop-color="#E7E5DC"/><stop offset="1" stop-color="#F1F0E9"/></linearGradient>
  <linearGradient id="tile-rim" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="#6E706F"/><stop offset=".24" stop-color="#41423F"/><stop offset=".58" stop-color="#101110"/><stop offset="1" stop-color="#565651"/></linearGradient>
  <pattern id="brushed" width="1" height=".11" patternUnits="userSpaceOnUse"><path d="M0 .018H1" fill="none" stroke="#FFFFFF" stroke-width=".018" opacity=".24"/><path d="M0 .075H1" fill="none" stroke="#1C2022" stroke-width=".013" opacity=".18"/></pattern>
  <clipPath id="mark-clip"><path d="${geometry}"/></clipPath>
  <filter id="mark-shadow" x="-20%" y="-20%" width="150%" height="160%"><feGaussianBlur stdDeviation=".52"/></filter>
  <filter id="tile-shadow" x="-20%" y="-20%" width="140%" height="160%"><feGaussianBlur stdDeviation="2.2"/></filter>
  </defs>`;
}
export function logoBody(mode, { carrier = false, detail = true, tiny = false } = {}) {
  const m = modes[mode];
  if (tiny) return `<path d="${geometry}" fill="${m.flat}"/>`;
  const metal = mode === 'dark' ? 'platinum' : 'obsidian';
  const rim = mode === 'dark' ? 'platinum-rim' : 'gold-rim';
  return `${detail && carrier && mode === 'dark' ? `<path d="${geometry}" fill="#000" opacity=".52" transform="translate(0 .62)" filter="url(#mark-shadow)"/>` : ''}
  <path d="${geometry}" fill="url(#${metal})"/>
  <g clip-path="url(#mark-clip)">
  ${detail ? '<rect width="32" height="32" fill="url(#brushed)" opacity=".3"/>' : ''}
  <path d="${geometry}" fill="none" stroke="url(#${rim})" stroke-width="${mode === 'light' && !carrier ? '.78' : '.42'}"/>
  ${detail ? '<path d="M8.1 2.55H22M2.55 8V19.5M28.65 9.4V21.8" stroke="#FFFFFF" stroke-opacity=".22" stroke-width=".14" fill="none" stroke-linecap="round"/>' : ''}
  </g>`;
}
