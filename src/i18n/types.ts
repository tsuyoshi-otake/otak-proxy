/**
 * Supported locales for the extension
 */
export type SupportedLocale =
    | 'en'
    | 'ja'
    | 'zh-cn'
    | 'zh-tw'
    | 'ko'
    | 'vi'
    // G20 country languages
    | 'es'    // Spanish (Argentina, Mexico)
    | 'pt-br' // Portuguese (Brazil)
    | 'fr'    // French (France, Canada)
    | 'de'    // German (Germany)
    | 'hi'    // Hindi (India)
    | 'id'    // Indonesian (Indonesia)
    | 'it'    // Italian (Italy)
    | 'ru'    // Russian (Russia)
    | 'ar'    // Arabic (Saudi Arabia)
    | 'tr';   // Turkish (Turkey)

/**
 * Translation messages structure
 * Key-value pairs where key is the message identifier and value is the translated string
 */
export interface TranslationMessages {
    [key: string]: string;
}

/**
 * I18n configuration
 */
export interface I18nConfig {
    /** Default locale to use on initialization */
    defaultLocale: SupportedLocale;
    /** List of supported locales */
    supportedLocales: SupportedLocale[];
    /** Fallback locale when translation is missing or locale is not supported */
    fallbackLocale: SupportedLocale;
}
