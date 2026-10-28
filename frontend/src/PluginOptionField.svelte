<script lang="ts">
  import { t } from './i18n';
  import {
    Button,
    Checkbox,
    RadioButton,
    RadioButtonGroup,
    Select,
    SelectItem,
    Slider,
    TextInput,
  } from 'carbon-components-svelte';
  import ColorPicker from './ColorPicker.svelte';
  import type { OptionDescriptor, OptionValue } from '../../backend/src/plugin-options';
  // One plugin option as a Carbon control. Values change on commit (a slider's release or
  // keyboard step, a text field's input), and `undefined` resets the option.
  let {
    option,
    value,
    disabled = false,
    invalidSaved = false,
    dark,
    text,
    onChange,
  }: {
    option: OptionDescriptor;
    value: OptionValue;
    disabled?: boolean;
    invalidSaved?: boolean;
    dark: boolean;
    /** Resolves the plugin's message keys: labels, help, units and choices. */
    text: (key: string) => string;
    onChange: (value: OptionValue | undefined) => void;
  } = $props();
  let label = $derived(text(option.label)),
    help = $derived(
      invalidSaved
        ? $t('panelSettings.options.invalidSaved')
        : option.help
          ? text(option.help)
          : '',
    ),
    unit = $derived(option.unit ? text(option.unit) : '');
  let colorAnchor = $state<HTMLElement | null>(null),
    picking = $state(false);
  const numeric = (raw: unknown) => {
    const next = Number(raw);
    return raw === '' || raw === null || !Number.isFinite(next) ? undefined : next;
  };
</script>

{#if option.type === 'boolean'}<Checkbox
    labelText={label}
    helperText={help}
    {disabled}
    checked={value === true}
    on:change={(event) => onChange((event.target as HTMLInputElement).checked)}
  />{:else if (option.type === 'number' || option.type === 'integer') && option.control === 'slider'}<Slider
    aria-label={label}
    labelText={label}
    helperText={help}
    {disabled}
    min={option.min}
    max={option.max}
    step={option.step ?? 1}
    formatValue={unit ? (number: number) => number + ' ' + unit : undefined}
    value={Number(value)}
    on:change={(event) => onChange(Number(event.detail))}
  />{:else if option.type === 'number' || option.type === 'integer'}<TextInput
    labelText={unit ? label + ' (' + unit + ')' : label}
    helperText={help}
    type="number"
    {disabled}
    value={String(value)}
    invalid={option.type === 'integer' && !Number.isInteger(Number(value))}
    on:change={(event) => {
      const next = numeric(event.detail);
      onChange(
        next === undefined
          ? undefined
          : Math.min(
              option.max ?? Infinity,
              Math.max(
                option.min ?? -Infinity,
                option.type === 'integer' ? Math.round(next) : next,
              ),
            ),
      );
    }}
  />{:else if option.type === 'select' && option.control === 'radio'}<RadioButtonGroup
    legendText={label}
    helperText={help}
    {disabled}
    selected={String(value)}
    on:change={(event) =>
      onChange(option.choices!.find((choice) => String(choice.value) === event.detail)?.value)}
    >{#each option.choices! as choice}<RadioButton
        labelText={text(choice.label)}
        value={String(choice.value)}
      />{/each}</RadioButtonGroup
  >{:else if option.type === 'select'}<Select
    labelText={label}
    helperText={help}
    {disabled}
    selected={String(value)}
    on:change={(event) =>
      onChange(
        option.choices!.find(
          (choice) => String(choice.value) === (event.target as HTMLSelectElement).value,
        )?.value,
      )}
    >{#each option.choices! as choice}<SelectItem
        value={String(choice.value)}
        text={text(choice.label)}
      />{/each}</Select
  >{:else if option.type === 'text'}<TextInput
    labelText={label}
    helperText={help}
    {disabled}
    maxlength={option.maxLength ?? 200}
    value={String(value)}
    on:input={(event) => onChange(String(event.detail ?? ''))}
  />{:else}<div class="option-color">
    <span class="bx--label" class:bx--label--disabled={disabled}>{label}</span>
    <div bind:this={colorAnchor}>
      <Button
        kind="tertiary"
        size="small"
        {disabled}
        aria-haspopup="dialog"
        on:click={() => (picking = true)}
        ><span class="option-swatch" style:background={String(value)} aria-hidden="true"
        ></span>{String(value)}</Button
      >
    </div>
    {#if help}<div class="bx--form__helper-text">{help}</div>{/if}
  </div>
  {#if picking && colorAnchor}<ColorPicker
      {dark}
      anchor={colorAnchor.querySelector('button') || colorAnchor}
      value={String(value)}
      name={label}
      onChange={(color) => onChange(color ?? undefined)}
      onClose={() => (picking = false)}
    />{/if}{/if}

<style>
  .option-color {
    display: grid;
    gap: 0.5rem;
    justify-items: start;
  }
  .option-swatch {
    display: inline-block;
    width: 1rem;
    height: 1rem;
    margin-right: 0.5rem;
    border: 1px solid var(--cds-border-strong);
    vertical-align: text-bottom;
  }
</style>
