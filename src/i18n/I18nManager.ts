import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SupportedLocale, TranslationMessages, I18nConfig } from './types';
import { Logger } from '../utils/Logger';

/**
 * I18nManager handles internationalization for the extension.
 * It detects the user's language, loads translation files, and provides translated messages.
 * 
 * This is a singleton class - use getInstance() to access it.
 */
export class I18nManager {
    private static instance: I18nManager;
    private currentLocale: SupportedLocale;
    private messages: TranslationMessages;
    private fallbackMessages: TranslationMessages;
    private config: I18nConfig;

    private constructor() {
        this.config = {
            defaultLocale: 'en',
            supportedLocales: ['en', 'ja'],
            fallbackLocale: 'en'
        };
        this.currentLocale = this.config.defaultLocale;
        this.messages = {};
        this.fallbackMessages = {};
    }

    /**
     * Get the singleton instance of I18nManager
     */
    public static getInstance(): I18nManager {
        if (!I18nManager.instance) {
            I18nManager.instance = new I18nManager();
        }
        return I18nManager.instance;
    }

    /**
     * Initialize the I18nManager by detecting the language and loading translation files
     * @param locale - Optional locale to use. If not provided, detects from vscode.env.language
     */
    public initialize(locale?: string): void {
        // Detect locale
        const detectedLocale = locale || vscode.env.language;
        Logger.log(`Detected locale: ${detectedLocale}`);

        // Check if the detected locale is supported
        if (this.isSupportedLocale(detectedLocale)) {
            this.currentLocale = detectedLocale as SupportedLocale;
        } else {
            // Fallback to default locale for unsupported languages
            Logger.warn(`Locale '${detectedLocale}' is not supported. Falling back to '${this.config.fallbackLocale}'`);
            this.currentLocale = this.config.fallbackLocale;
        }

        // Load translation files
        this.loadTranslations();
    }

    /**
     * Check if a locale is supported
     */
    private isSupportedLocale(locale: string): boolean {
        return this.config.supportedLocales.includes(locale as SupportedLocale);
    }

    /**
     * Load translation files for the current locale and fallback locale
     */
    private loadTranslations(): void {
        try {
            // Load current locale translations
            this.messages = this.loadLocaleFile(this.currentLocale);
            Logger.log(`Loaded translations for locale: ${this.currentLocale}`);

            // Load fallback locale translations if different from current
            if (this.currentLocale !== this.config.fallbackLocale) {
                this.fallbackMessages = this.loadLocaleFile(this.config.fallbackLocale);
                Logger.log(`Loaded fallback translations for locale: ${this.config.fallbackLocale}`);
            } else {
                this.fallbackMessages = this.messages;
            }
        } catch (error) {
            Logger.error('Failed to load translations:', error);
            // Try to load fallback locale as last resort
            try {
                this.messages = this.loadLocaleFile(this.config.fallbackLocale);
                this.fallbackMessages = this.messages;
                this.currentLocale = this.config.fallbackLocale;
                Logger.log(`Loaded fallback translations after error`);
            } catch (fallbackError) {
                Logger.error('Failed to load fallback translations:', fallbackError);
                this.messages = {};
                this.fallbackMessages = {};
            }
        }
    }

    /**
     * Load a locale file from disk
     */
    private loadLocaleFile(locale: SupportedLocale): TranslationMessages {
        const localeFilePath = path.join(__dirname, 'locales', `${locale}.json`);
        
        try {
            const fileContent = fs.readFileSync(localeFilePath, 'utf-8');
            const translations = JSON.parse(fileContent) as TranslationMessages;
            return translations;
        } catch (error) {
            if (error instanceof SyntaxError) {
                // JSON parse error
                Logger.error(`JSON parse error in locale file '${localeFilePath}':`, error);
                throw new Error(`Invalid JSON in locale file: ${locale}.json`);
            } else {
                // File not found or read error
                Logger.error(`Failed to read locale file '${localeFilePath}':`, error);
                throw new Error(`Failed to load locale file: ${locale}.json`);
            }
        }
    }

    /**
     * Get a translated message by key
     * @param key - Message key
     * @param params - Optional parameters for placeholder substitution
     * @returns Translated message with parameters substituted
     */
    public t(key: string, params?: Record<string, string>): string {
        // Try to get translation from current locale
        let message = this.messages[key];

        // If not found, try fallback locale
        if (!message) {
            Logger.warn(`Translation key '${key}' not found for locale '${this.currentLocale}'. Using fallback.`);
            message = this.fallbackMessages[key];
        }

        // If still not found, return the key itself with a marker
        if (!message) {
            Logger.warn(`Translation key '${key}' not found in fallback locale '${this.config.fallbackLocale}'.`);
            return `[missing: ${key}]`;
        }

        // Substitute parameters if provided
        if (params) {
            return this.substituteParams(message, params);
        }

        return message;
    }

    /**
     * Substitute parameters in a message
     * @param message - Message with placeholders like {paramName}
     * @param params - Parameters to substitute
     * @returns Message with parameters substituted
     */
    private substituteParams(message: string, params: Record<string, string>): string {
        let result = message;
        for (const [key, value] of Object.entries(params)) {
            const placeholder = `{${key}}`;
            // Escape special regex characters in the placeholder
            const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            result = result.replace(new RegExp(escapedPlaceholder, 'g'), value);
        }
        return result;
    }

    /**
     * Get the current locale
     */
    public getCurrentLocale(): SupportedLocale {
        return this.currentLocale;
    }
}
