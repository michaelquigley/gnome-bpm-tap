import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

const MIN_BPM = 40;
const MAX_BPM = 300;
const DEFAULT_BPM = 120;

// Drop the running average if the gap between two taps exceeds this (µs).
const TAP_TIMEOUT_US = 2_000_000;
// How many recent intervals to average.
const MAX_INTERVALS = 8;

// Note divisions, expressed as a multiplier of the quarter-note duration.
// quarter = 60000 / BPM ms.
const DIVISIONS = [
    {label: '1/4',   factor: 1},
    {label: '1/8',   factor: 0.5},
    {label: '1/16',  factor: 0.25},
    {label: '1/32',  factor: 0.125},
    {label: '1/64',  factor: 0.0625},
    {label: '1/128', factor: 0.03125},
];

const VARIANTS = [
    {label: 'Normal',  mult: 1},
    {label: 'Dotted',  mult: 1.5},
    {label: 'Triplet', mult: 2 / 3},
];

function clampBpm(bpm) {
    return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
}

function formatMs(ms) {
    // Keep it compact but precise enough for delay times.
    if (ms >= 100)
        return `${ms.toFixed(1)}`;
    return `${ms.toFixed(2)}`;
}

const BpmIndicator = GObject.registerClass(
class BpmIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'BPM Tap', false);

        this._settings = settings;
        this._bpm = clampBpm(settings.get_int('last-bpm'));
        this._lastTap = 0;
        this._intervals = [];
        this._cells = []; // {button, label, factor, mult}
        this._feedbackId = 0;

        this._appearanceId = settings.connect('changed::show-tempo-label',
            () => this._refresh());

        this._panelLabel = new St.Label({
            text: `♪ ${this._bpm}`,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'bpm-panel-label',
        });
        this.add_child(this._panelLabel);

        this._buildMenu();
        this._refresh();
    }

    _buildMenu() {
        // --- Tap + readout ---
        const top = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const topBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style: 'spacing: 4px;',
        });

        const readoutBox = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style: 'spacing: 6px;',
        });
        this._readout = new St.Label({
            text: `${this._bpm}`,
            y_align: Clutter.ActorAlign.END,
            style_class: 'bpm-readout',
        });
        readoutBox.add_child(this._readout);
        readoutBox.add_child(new St.Label({
            text: 'BPM',
            y_align: Clutter.ActorAlign.END,
            style_class: 'bpm-readout-unit',
        }));
        topBox.add_child(readoutBox);

        const tapButton = new St.Button({
            label: 'TAP',
            x_expand: true,
            can_focus: true,
            style_class: 'bpm-tap-button',
        });
        tapButton.connect('clicked', () => this._onTap());
        topBox.add_child(tapButton);

        // --- Manual fine-tune: − [slider] + ---
        const tuneBox = new St.BoxLayout({
            x_expand: true,
            style: 'spacing: 8px;',
        });
        const minus = new St.Button({
            label: '−',
            can_focus: true,
            style_class: 'bpm-step-button',
            y_align: Clutter.ActorAlign.CENTER,
        });
        minus.connect('clicked', () => this._setBpm(this._bpm - 1));

        this._slider = new Slider(
            (this._bpm - MIN_BPM) / (MAX_BPM - MIN_BPM));
        this._slider.x_expand = true;
        this._slider.connect('notify::value', () => {
            const v = MIN_BPM + this._slider.value * (MAX_BPM - MIN_BPM);
            this._setBpm(v, /* fromSlider */ true);
        });

        const plus = new St.Button({
            label: '+',
            can_focus: true,
            style_class: 'bpm-step-button',
            y_align: Clutter.ActorAlign.CENTER,
        });
        plus.connect('clicked', () => this._setBpm(this._bpm + 1));

        tuneBox.add_child(minus);
        tuneBox.add_child(this._slider);
        tuneBox.add_child(plus);
        topBox.add_child(tuneBox);

        top.add_child(topBox);
        this.menu.addMenuItem(top);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- Division grid ---
        const gridItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const grid = new St.Widget({
            layout_manager: new Clutter.GridLayout(),
            x_expand: true,
            style_class: 'bpm-grid',
        });
        const gl = grid.layout_manager;

        // Header row.
        gl.attach(new St.Label({text: 'Note', style_class: 'bpm-grid-head'}),
            0, 0, 1, 1);
        VARIANTS.forEach((v, i) => {
            gl.attach(new St.Label({
                text: v.label,
                style_class: 'bpm-grid-head',
            }), i + 1, 0, 1, 1);
        });

        DIVISIONS.forEach((div, row) => {
            gl.attach(new St.Label({
                text: div.label,
                style_class: 'bpm-grid-note',
            }), 0, row + 1, 1, 1);

            VARIANTS.forEach((variant, col) => {
                const label = new St.Label({
                    text: '–',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                });
                const button = new St.Button({
                    child: label,
                    x_expand: true,
                    can_focus: true,
                    style_class: 'bpm-cell',
                });
                const cell = {
                    button,
                    label,
                    factor: div.factor,
                    mult: variant.mult,
                };
                button.connect('clicked', () => this._copyCell(cell));
                this._cells.push(cell);
                gl.attach(button, col + 1, row + 1, 1, 1);
            });
        });

        gridItem.add_child(grid);
        this.menu.addMenuItem(gridItem);

        // --- Hint / feedback line ---
        const hintItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._hint = new St.Label({
            text: 'Click a value to copy it (ms)',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'bpm-hint',
        });
        hintItem.add_child(this._hint);
        this.menu.addMenuItem(hintItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- Appearance toggle (BPM PRO's "two appearances") ---
        const appearance = new PopupMenu.PopupSwitchMenuItem(
            'Show tempo number in panel',
            this._settings.get_boolean('show-tempo-label'));
        appearance.connect('toggled', (_item, state) =>
            this._settings.set_boolean('show-tempo-label', state));
        this.menu.addMenuItem(appearance);

        // --- Reset ---
        const reset = new PopupMenu.PopupMenuItem('Reset');
        reset.connect('activate', () => {
            this._intervals = [];
            this._lastTap = 0;
            this._setBpm(DEFAULT_BPM);
            this._setHint('Reset');
        });
        this.menu.addMenuItem(reset);
    }

    _onTap() {
        const now = GLib.get_monotonic_time(); // microseconds

        if (this._lastTap && now - this._lastTap > TAP_TIMEOUT_US) {
            this._intervals = []; // gap too long — start a new measurement
        }

        if (this._lastTap) {
            this._intervals.push(now - this._lastTap);
            if (this._intervals.length > MAX_INTERVALS)
                this._intervals.shift();
        }
        this._lastTap = now;

        if (this._intervals.length > 0) {
            const sum = this._intervals.reduce((a, b) => a + b, 0);
            const avgUs = sum / this._intervals.length;
            this._setBpm(60_000_000 / avgUs);
            this._setHint(`Averaging ${this._intervals.length} tap(s)`);
        } else {
            this._setHint('Keep tapping…');
        }
    }

    _setBpm(bpm, fromSlider = false) {
        const next = clampBpm(bpm);
        if (next === this._bpm && !fromSlider) {
            this._refresh();
            return;
        }
        this._bpm = next;
        this._settings.set_int('last-bpm', next);
        this._refresh(fromSlider);
    }

    _refresh(fromSlider = false) {
        const showLabel = this._settings.get_boolean('show-tempo-label');
        this._panelLabel.text = showLabel ? `♪ ${this._bpm}` : '♪';
        this._readout.text = `${this._bpm}`;

        if (!fromSlider && this._slider) {
            const pos = (this._bpm - MIN_BPM) / (MAX_BPM - MIN_BPM);
            this._slider.value = Math.min(1, Math.max(0, pos));
        }

        const quarterMs = 60000 / this._bpm;
        for (const cell of this._cells) {
            const ms = quarterMs * cell.factor * cell.mult;
            cell.label.text = formatMs(ms);
            cell._ms = ms;
        }
    }

    _copyCell(cell) {
        const text = formatMs(cell._ms);
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._setHint(`Copied ${text} ms`);
    }

    _setHint(text) {
        this._hint.text = text;
        if (this._feedbackId) {
            GLib.source_remove(this._feedbackId);
            this._feedbackId = 0;
        }
        this._feedbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._hint.text = 'Click a value to copy it (ms)';
            this._feedbackId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._feedbackId) {
            GLib.source_remove(this._feedbackId);
            this._feedbackId = 0;
        }
        if (this._appearanceId) {
            this._settings.disconnect(this._appearanceId);
            this._appearanceId = 0;
        }
        super.destroy();
    }
});

export default class BpmExtension extends Extension {
    enable() {
        this._indicator = new BpmIndicator(this.getSettings());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
