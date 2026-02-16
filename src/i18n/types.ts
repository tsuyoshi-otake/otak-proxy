/**
 * Supported locales for the extension
 */
export type SupportedLocale = 'en' | 'ja' | 'zh-cn' | 'zh-tw' | 'ko';

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
