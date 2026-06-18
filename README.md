# BPM Tap

A GNOME Shell extension that lives in the top panel as a tap-tempo calculator.
Tap to detect BPM and read the millisecond delay times for each note division
(normal, dotted, triplet). Click any value to copy it — handy for dialing in
delay and reverb times in a DAW.

Inspired by [BPM PRO for macOS](https://bpmpro.hypertron-instrument.com/).

## Features

- **Top-panel indicator** showing the current BPM.
- **Tap tempo** — a large `TAP` button that averages the last 8 intervals and
  resets the average after a 2-second pause.
- **Manual tempo** — `−`/`+` buttons and a slider (40–300 BPM).
- **Division grid** — rows `1/1` … `1/32`, columns Normal / Dotted / Triplet,
  each showing the time in milliseconds.
- **Click to copy** — click any cell to copy its millisecond value to the
  clipboard.
- **Reset** — back to 120 BPM.

The timing math: a quarter note is `60000 / BPM` ms; dotted values are ×1.5,
triplet values are ×2⁄3.

## Install

### From source

```sh
git clone https://github.com/michaelquigley/gnome-bpm-tap.git
ln -s "$PWD/gnome-bpm-tap/src" \
  "$HOME/.local/share/gnome-shell/extensions/bpm-tap@quigley.com"
```

Then restart GNOME Shell:

- **X11:** press `Alt+F2`, type `r`, press `Enter`.
- **Wayland:** log out and back in.

Enable it:

```sh
gnome-extensions enable bpm-tap@quigley.com
```

## Develop

The extension source lives in [`src/`](src/). To build a distributable zip:

```sh
cd src
gnome-extensions pack \
  --extra-source=stylesheet.css \
  --out-dir=..
```

## License

GPL-2.0-or-later
