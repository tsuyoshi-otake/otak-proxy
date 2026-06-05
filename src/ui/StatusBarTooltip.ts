import * as vscode from 'vscode';
import { ProxyMode, ProxyState } from '../core/types';
import { I18nManager } from '../i18n/I18nManager';
import { InputSanitizer } from '../validation/InputSanitizer';
import { Logger } from '../utils/Logger';
import type { LastCheckInfo, MonitorState } from './StatusBarManager';
import { getUrlDisplay } from './StatusBarDisplay';

export interface StatusBarTooltipOptions {
    state: ProxyState;
    statusText: string;
    monitorState: MonitorState | null;
    lastCheck: LastCheckInfo | null;
    i18n: I18nManager;
    sanitizer: InputSanitizer;
    registeredCommands: readonly string[];
    showUrl: boolean;
}

export function buildStatusBarTooltip(options: StatusBarTooltipOptions): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.supportThemeIcons = true;

    tooltip.appendMarkdown(`**${options.i18n.t('statusbar.tooltip.title')}**\n\n`);
    appendKeyValue(tooltip, options.i18n.t('statusbar.tooltip.currentMode'), options.state.mode.toUpperCase());
    appendKeyValue(tooltip, options.i18n.t('statusbar.tooltip.status'), options.statusText);

    appendAutoCheckInfo(tooltip, options);
    appendMonitoringInfo(tooltip, options);
    appendProxyUrls(tooltip, options);

    tooltip.appendMarkdown(`---\n\n`);
    appendCommandLinks(tooltip, options);

    return tooltip;
}

function appendKeyValue(tooltip: vscode.MarkdownString, label: string, value: unknown): void {
    tooltip.appendMarkdown(`**${label}:** `);
    tooltip.appendText(String(value));
    tooltip.appendMarkdown('\n\n');
}

function appendAutoCheckInfo(tooltip: vscode.MarkdownString, options: StatusBarTooltipOptions): void {
    const { state, lastCheck, i18n } = options;

    if (state.mode !== ProxyMode.Auto || !lastCheck) {
        return;
    }

    const lastCheckTime = new Date(lastCheck.timestamp).toLocaleTimeString();
    appendKeyValue(tooltip, i18n.t('statusbar.tooltip.lastCheck'), lastCheckTime);

    if (lastCheck.source) {
        appendKeyValue(tooltip, i18n.t('statusbar.tooltip.detectionSource'), lastCheck.source);
    }

    if (!lastCheck.success && lastCheck.error) {
        tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.lastError')}:** $(warning) `);
        tooltip.appendText(lastCheck.error);
        tooltip.appendMarkdown('\n\n');
    }
}

function appendMonitoringInfo(tooltip: vscode.MarkdownString, options: StatusBarTooltipOptions): void {
    const { state, monitorState, i18n } = options;

    if (state.mode === ProxyMode.Auto && monitorState && monitorState.consecutiveFailures > 0) {
        tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.consecutiveFailures')}:** $(warning) ${monitorState.consecutiveFailures}\n\n`);
    }
}

function appendProxyUrls(tooltip: vscode.MarkdownString, options: StatusBarTooltipOptions): void {
    const { state, showUrl, i18n, sanitizer } = options;

    if (state.manualProxyUrl) {
        appendKeyValue(
            tooltip,
            i18n.t('statusbar.tooltip.manualProxy'),
            getUrlDisplay(state.manualProxyUrl, showUrl, i18n, sanitizer)
        );
    }

    if (state.autoProxyUrl) {
        appendKeyValue(
            tooltip,
            i18n.t('statusbar.tooltip.systemProxy'),
            getUrlDisplay(state.autoProxyUrl, showUrl, i18n, sanitizer)
        );
    }
}

function appendCommandLinks(tooltip: vscode.MarkdownString, options: StatusBarTooltipOptions): void {
    const { i18n, registeredCommands, showUrl } = options;
    const toggleUrlIcon = showUrl ? '$(eye-closed)' : '$(eye)';
    const toggleUrlLabel = showUrl
        ? i18n.t('statusbar.link.hideProxyUrl')
        : i18n.t('statusbar.link.showProxyUrl');

    const commandLinks = [
        { icon: '$(sync)', label: i18n.t('statusbar.link.toggleMode'), command: 'otak-proxy.toggleProxy' },
        { icon: '$(gear)', label: i18n.t('statusbar.link.configureManual'), command: 'otak-proxy.configureUrl' },
        { icon: '$(cloud-download)', label: i18n.t('statusbar.link.importSystem'), command: 'otak-proxy.importProxy' },
        { icon: '$(debug-start)', label: i18n.t('statusbar.link.testProxy'), command: 'otak-proxy.testProxy' },
        { icon: toggleUrlIcon, label: toggleUrlLabel, command: 'otak-proxy.toggleShowProxyUrl' }
    ];

    for (const link of commandLinks) {
        if (!registeredCommands.includes(link.command)) {
            Logger.warn(`Command link references unregistered command: ${link.command}`);
        }
    }

    const linkMarkdown = commandLinks
        .map(link => `${link.icon} [${link.label}](command:${link.command})`)
        .join(' &nbsp;&nbsp; ');
    tooltip.appendMarkdown(linkMarkdown);
}
