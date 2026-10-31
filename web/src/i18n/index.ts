import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';
import uk from './locales/uk.json';

i18n.use(LanguageDetector).init({
  resources: {
    en: { translation: en },
    uk: { translation: uk },
  },
  fallbackLng: 'en',
  supportedLngs: ['en', 'uk'],
  nsSeparator: false,
  interpolation: { escapeValue: false },
  detection: {
    order: ['localStorage', 'navigator'],
    caches: ['localStorage'],
    lookupLocalStorage: 'coreprotect-map-lang',
  },
});

export const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, opts) as string;
export default i18n;
