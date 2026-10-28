<script lang="ts">
  import { t, type MessageKey } from './i18n';

  import { onMount, untrack } from 'svelte';
  import { Button, TextInput } from 'carbon-components-svelte';
  import Close from 'carbon-icons-svelte/lib/Close.svelte';
  import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte';
  import { contrast } from './theme';
  import { resolvePaletteColor, runPalette } from './run-colors';
  let {
    dark,
    anchor,
    value,
    name,
    onChange,
    onClose,
  }: {
    dark: boolean;
    anchor: HTMLElement;
    value: string;
    name: string;
    onChange: (color: string | null) => void;
    onClose: () => void;
  } = $props();
  let popup: HTMLDivElement, field: HTMLDivElement;
  let hex = $state(untrack(() => value)),
    hue = $state(0),
    saturation = $state(0),
    brightness = $state(0),
    dragging = false;
  // W&B's run color picker presets, in its spectrum order.
  const presets: [MessageKey, string][] = [
    ['colors.palette.red', runPalette[1].light],
    ['colors.palette.orange', runPalette[5].light],
    ['colors.palette.peach', runPalette[11].light],
    ['colors.palette.yellow', runPalette[8].light],
    ['colors.palette.lime', runPalette[12].light],
    ['colors.palette.kellyGreen', runPalette[2].light],
    ['colors.palette.forest', runPalette[10].light],
    ['colors.palette.seafoam', runPalette[6].light],
    ['colors.palette.cyan', runPalette[9].light],
    ['colors.palette.blue', runPalette[0].light],
    ['colors.palette.purple', runPalette[3].light],
    ['colors.palette.pink', runPalette[4].light],
    ['colors.palette.magenta', runPalette[7].light],
    ['colors.palette.maroon', runPalette[14].light],
    ['colors.palette.brown', runPalette[13].light],
    ['colors.palette.gray', runPalette[15].light],
  ];
  function fromHex(color: string) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255),
      max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      d = max - min;
    hue =
      d === 0
        ? 0
        : (max === r
            ? (g - b) / d + (g < b ? 6 : 0)
            : max === g
              ? (b - r) / d + 2
              : (r - g) / d + 4) * 60;
    saturation = max ? (d / max) * 100 : 0;
    brightness = max * 100;
    hex = color;
  }
  function toHex() {
    const s = saturation / 100,
      v = brightness / 100,
      c = v * s,
      x = c * (1 - Math.abs(((hue / 60) % 2) - 1)),
      m = v - c;
    const channels =
      hue < 60
        ? [c, x, 0]
        : hue < 120
          ? [x, c, 0]
          : hue < 180
            ? [0, c, x]
            : hue < 240
              ? [0, x, c]
              : hue < 300
                ? [x, 0, c]
                : [c, 0, x];
    hex =
      '#' +
      channels
        .map((n) =>
          Math.round((n + m) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('');
  }
  function position() {
    if (!anchor.isConnected) {
      onClose();
      return;
    }
    const rect = anchor.getBoundingClientRect(),
      width = Math.min(280, window.innerWidth - 24),
      height = popup.offsetHeight;
    popup.style.width = width + 'px';
    popup.style.left =
      Math.max(12, Math.min(window.innerWidth - width - 12, rect.right + 8)) + 'px';
    popup.style.top = Math.max(12, Math.min(window.innerHeight - height - 12, rect.top)) + 'px';
  }
  onMount(() => {
    fromHex(value);
    popup.showPopover();
    position();
    popup.querySelector<HTMLInputElement>('input.bx--text-input')?.focus();
    const observer = new ResizeObserver(position);
    observer.observe(popup);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      if (
        anchor.isConnected &&
        (popup.contains(document.activeElement) || document.activeElement === document.body)
      )
        anchor.focus();
    };
  });
  function choose(color: string) {
    fromHex(color);
    onChange(color);
  }
  function pick(event: PointerEvent) {
    const rect = field.getBoundingClientRect();
    saturation = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    brightness = Math.max(0, Math.min(100, 100 - ((event.clientY - rect.top) / rect.height) * 100));
    toHex();
  }
</script>

<div
  class="color-popover"
  popover="auto"
  bind:this={popup}
  role="dialog"
  aria-label={$t('colors.picker.label', { name: name })}
  ontoggle={(event) => {
    if ((event as ToggleEvent).newState === 'closed') onClose();
  }}
>
  <div class="popover-heading">
    <h3>{$t('colors.picker.title')}</h3>
    <Button
      kind="ghost"
      size="small"
      icon={Close}
      hideTooltip
      title={$t('colors.picker.close')}
      iconDescription={$t('colors.picker.close')}
      tooltipAlignment="end"
      on:click={onClose}
    />
  </div>
  <div
    class="color-plane"
    bind:this={field}
    style:background-color={'hsl(' + hue + ' 100% 50%)'}
    role="slider"
    tabindex="0"
    aria-label={$t('colors.picker.saturationBrightness')}
    aria-valuetext={$t('colors.picker.saturationBrightnessValue', {
      saturation: Math.round(saturation),
      brightness: Math.round(brightness),
    })}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(saturation)}
    onpointerdown={(event) => {
      dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      pick(event);
    }}
    onpointermove={(event) => {
      if (dragging) pick(event);
    }}
    onpointerup={() => {
      dragging = false;
      onChange(hex);
    }}
    onpointercancel={() => (dragging = false)}
    onkeydown={(event) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const delta = event.shiftKey ? 10 : 1;
        if (event.key === 'ArrowLeft') saturation = Math.max(0, saturation - delta);
        if (event.key === 'ArrowRight') saturation = Math.min(100, saturation + delta);
        if (event.key === 'ArrowDown') brightness = Math.max(0, brightness - delta);
        if (event.key === 'ArrowUp') brightness = Math.min(100, brightness + delta);
        toHex();
        onChange(hex);
      }
    }}
  >
    <span style:left={saturation + '%'} style:top={100 - brightness + '%'}></span>
  </div>
  <input
    class="hue-strip"
    type="range"
    min="0"
    max="359"
    step="1"
    aria-label={$t('colors.picker.hue')}
    bind:value={hue}
    oninput={toHex}
    onchange={() => onChange(hex)}
  />

  <div class="color-value">
    <span style:background={resolvePaletteColor(hex, dark)} aria-hidden="true"></span><TextInput
      labelText={$t('colors.picker.hex')}
      hideLabel
      size="sm"
      value={hex}
      maxlength={7}
      on:input={(event) => {
        const color = String(event.detail);
        if (/^#[a-f\d]{6}$/i.test(color)) choose(color);
      }}
    />
  </div>
  <div class="color-swatches">
    {#each presets as [label, choice]}<button
        type="button"
        title={$t(label)}
        aria-label={$t(label)}
        aria-pressed={hex.toLowerCase() === choice.toLowerCase()}
        style:background={resolvePaletteColor(choice, dark)}
        style:color={contrast(resolvePaletteColor(choice, dark), '#ffffff') >
        contrast(resolvePaletteColor(choice, dark), '#000000')
          ? '#ffffff'
          : '#000000'}
        onclick={() => choose(choice)}
        >{#if hex.toLowerCase() === choice.toLowerCase()}<Checkmark size={18} />{/if}</button
      >{/each}
  </div>
  <Button
    kind="ghost"
    size="small"
    on:click={() => {
      onChange(null);
      onClose();
    }}>{$t('colors.picker.reset')}</Button
  >
</div>
