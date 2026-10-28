import { derived, writable } from 'svelte/store';
import english from './locales/en.json';

export type Locale = 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' | 'ko' | 'fr' | 'es';
export type LanguagePreference = Locale | 'auto';
export type Values = Record<string, string | number>;
type CatalogKey = keyof typeof english;
type PluralBase<K> = K extends `${infer Base}.${'one' | 'other'}` ? Base : never;
/** A catalog key, or the base of a plural key pair (`base.one` and `base.other`). */
export type MessageKey =
  Exclude<CatalogKey, `${string}.${'one' | 'other'}`> | PluralBase<CatalogKey>;
/** A catalog message, or literal text (such as server or user data) shown as is. */
export type Message = '' | MessageKey | { key: MessageKey; values: Values } | { text: string };
export type Translator = (message: Message | undefined | null, values?: Values) => string;
export const languages: { id: Locale; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'zh-Hans', name: '简体中文' },
  { id: 'zh-Hant', name: '繁體中文' },
  { id: 'ja', name: '日本語' },
  { id: 'ko', name: '한국어' },
  { id: 'fr', name: 'Français' },
  { id: 'es', name: 'Español' },
];
const loaders = {
  'zh-Hans': () => import('./locales/zh-Hans.json'),
  'zh-Hant': () => import('./locales/zh-Hant.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  fr: () => import('./locales/fr.json'),
  es: () => import('./locales/es.json'),
};
const active = writable<{ locale: Locale; messages: Record<string, string> }>({
  locale: 'en',
  messages: english,
});
export const locale = derived(active, (value) => value.locale);
export const languagePreference = writable<LanguagePreference>('auto');
export function browserLocale(values: readonly string[]): Locale {
  for (const value of values) {
    const tag = value.toLowerCase();
    if (tag.startsWith('zh')) return /hant|tw|hk|mo/.test(tag) ? 'zh-Hant' : 'zh-Hans';
    for (const id of ['ja', 'ko', 'fr', 'es', 'en'] as const) if (tag.startsWith(id)) return id;
  }
  return 'en';
}
/**
 * Missing keys are programming errors. Development builds, tests and automated browsers throw;
 * production builds report the key once and show it.
 */
const strict =
  import.meta.env?.PROD !== true ||
  (typeof navigator !== 'undefined' && navigator.webdriver === true);
const reported = new Set<string>();
function missing(key: string) {
  if (strict) throw Error('Missing interface message: ' + key);
  if (!reported.has(key)) console.error('Missing interface message: ' + key);
  reported.add(key);
  return key;
}
export const t = derived(active, ({ locale, messages }): Translator => {
  const plural = new Intl.PluralRules(locale),
    numbers = new Intl.NumberFormat(locale);
  return (message, values = {}) => {
    if (message == null || message === '') return '';
    if (typeof message === 'object' && 'text' in message) return message.text;
    const key: string = typeof message === 'string' ? message : message.key;
    const params = typeof message === 'string' ? values : message.values;
    let text: string;
    if (Object.hasOwn(messages, key)) text = messages[key];
    else if (Object.hasOwn(messages, key + '.other')) {
      const form = key + '.' + plural.select(Number(params.count));
      text = Object.hasOwn(messages, form) ? messages[form] : messages[key + '.other'];
    } else text = missing(key);
    return text.replace(/\{(\w+)\}/g, (token, name) => {
      const value = params[name];
      return value === undefined
        ? token
        : typeof value === 'number'
          ? numbers.format(value)
          : value;
    });
  };
});
export const number=derived(locale,lang=>{
  const formats=new Map<string,Intl.NumberFormat>();
  return (value:number,options?:Intl.NumberFormatOptions)=>{const key=JSON.stringify(options||{});let format=formats.get(key);if(!format){format=new Intl.NumberFormat(lang,options);if(formats.size>=16)formats.delete(formats.keys().next().value!);formats.set(key,format);}return format.format(value);};
});
export const date=derived(locale,lang=>{
  const day=new Intl.DateTimeFormat(lang,{dateStyle:'medium'}),timestamp=new Intl.DateTimeFormat(lang,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short',hourCycle:'h23'});
  return (seconds:number,dateOnly=false)=>(dateOnly?day:timestamp).format(new Date(seconds*1000));
});
export async function setLanguage(preference: LanguagePreference) {
  const next = preference === 'auto' ? browserLocale(navigator.languages) : preference;
  const messages = next === 'en' ? english : (await loaders[next]()).default;
  active.set({ locale: next, messages });
  languagePreference.set(preference);
  document.documentElement.lang = next;
  localStorage.setItem('randl.language', preference);
}
export async function initialiseLanguage() {
  const saved = localStorage.getItem('randl.language');
  const preference =
    saved === 'auto' || languages.some((item) => item.id === saved)
      ? (saved as LanguagePreference)
      : 'auto';
  await setLanguage(preference);
}
export function message(key: MessageKey, values: Values): Message {
  return { key, values };
}
export const duration = derived(locale, (lang) => {
  const style = ['zh-Hant', 'ja'].includes(lang) ? 'short' : 'narrow',
    units = ['day', 'hour', 'minute', 'second'],
    formats = units.map(
      (unit) => new Intl.NumberFormat(lang, { style: 'unit', unit, unitDisplay: style }),
    ),
    list = new Intl.ListFormat(lang, { style, type: 'unit' });
  return (seconds: number) => {
    const value = Math.max(0, Math.floor(seconds)),
      parts = [
        Math.floor(value / 86400),
        Math.floor(value / 3600) % 24,
        Math.floor(value / 60) % 60,
        value % 60,
      ];
    const first = parts.findIndex((value) => value > 0);
    return list.format(
      parts.flatMap((part, index) =>
        index >= (first < 0 ? 3 : first) ? [formats[index].format(part)] : [],
      ),
    );
  };
});
