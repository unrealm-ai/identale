import type { GlobalThemeOverrides } from 'naive-ui';
import { identaleDark, identaleLight } from './naive-theme';

/**
 * §7 decisions live here so they can be reverted without hunting pages:
 * - primaryIntent 'green' is the approved relay green. Set 'ink' for the near-black button.
 * - Rail stays dark in both themes via --id-bg-rail in tokens.css (revert that one variable).
 * - Desktop body density is Naive fontSize 14px from identaleLight/Dark. Mobile CSS returns to 16px.
 */
export const primaryIntent = 'green' as 'green' | 'ink';

const ink = {
  light: { brand: '#182024', hover: '#283137', pressed: '#0E1316', onPrimary: '#FFFFFF' },
  dark: { brand: '#E8EDEF', hover: '#FFFFFF', pressed: '#C9D0D4', onPrimary: '#0E1316' },
} as const;

/** Palette values are implementation primitives; pages consume semantic variables. */
export const primitives = {
  neutral0: '#ffffff', neutral25: '#fafbfb', neutral50: '#f4f6f7', neutral100: '#eceff1',
  neutral200: '#dfe4e7', neutral300: '#c9d0d4', neutral500: '#6f7b83', neutral600: '#56626a',
  neutral800: '#283137', neutral900: '#182024', neutral950: '#0e1316',
  mint50: '#eaf8f3', mint100: '#cdefe3', mint700: '#0f8167', mint800: '#0b6a55',
  amber50: '#fff4e0', amber800: '#9a5300', red50: '#fdecec', red700: '#c0262d', teal700: '#0b6a55',
} as const;

const green = {
  light: { brand: '#0F8167', hover: '#0B6A55', pressed: '#095544', onPrimary: '#FFFFFF' },
  dark: { brand: '#3BBD9B', hover: '#67C9A9', pressed: '#9EDFC8', onPrimary: '#04221B' },
} as const;

function intent(mode: 'light' | 'dark') {
  return (primaryIntent === 'ink' ? ink : green)[mode];
}

/** Existing short aliases stay available while feature styles migrate. */
export const palettes = {
  light: {
    background: '#F4F6F7', sidebar: '#0F1A1D', content: '#F4F6F7',
    surface: '#FFFFFF', overlay: '#FFFFFF',
    text: '#182024', heading: '#182024', muted: '#4C575E',
    meta: '#5F6B73', border: '#7E8A92', subtle: '#E6EAEC',
    ...intent('light'),
    tint: '#EAF8F3', selectedText: '#0B6A55',
    accent: '#0F8167', link: '#0B6A55', focus: '#1E9E7F',
    success: '#1B7A3A', successTint: '#E9F6EC',
    warning: '#9A5300', warningTint: '#FFF4E0',
    danger: '#C0262D', dangerTint: '#FDECEC',
    unknown: '#6B3FC2', unknownTint: '#F2EDFC',
    hoverTint: '#F0F3F4', disabled: '#4C575E', disabledTint: '#EEF1F2',
  },
  dark: {
    background: '#0C1114', sidebar: '#080C0E', content: '#0C1114', surface: '#141B1F', overlay: '#1A2227',
    text: '#E8EDEF', heading: '#E8EDEF', muted: '#AEB9BF', meta: '#93A0A7', border: '#6B7A82', subtle: '#222C31',
    ...intent('dark'),
    tint: '#10302A', selectedText: '#5FD3B2', accent: '#3BBD9B', link: '#5FD3B2', focus: '#67C9A9',
    success: '#7FD99A', successTint: '#12301C', warning: '#F6BE62', warningTint: '#33240C',
    danger: '#FF9A9E', dangerTint: '#3A1517', unknown: '#C3A8FF', unknownTint: '#261B3E',
    hoverTint: '#1F292E', disabled: '#93A0A7', disabledTint: '#1F282D',
  },
} as const;

export const dimensions = {
  radiusControl: '6px', radiusCard: '.75rem', radiusPanel: '1rem',
  controlSmall: '1.75rem', controlMedium: '2.25rem', controlLarge: '2.75rem',
  navWidth: '4.5rem', navRailWidth: '4.5rem', contentMaxWidth: '90rem',
} as const;

export function themeOverrides(mode: keyof typeof palettes, _compact = false): GlobalThemeOverrides {
  const base = mode === 'dark' ? identaleDark : identaleLight;
  const p = palettes[mode];
  return {
    ...base,
    common: {
      ...base.common,
      ...(_compact ? {fontSize:'16px', heightMedium:'44px'} : {}),
      primaryColor: p.brand, primaryColorHover: p.hover, primaryColorPressed: p.pressed, primaryColorSuppl: p.brand,
      textColorBase: p.text, textColor1: p.text, textColor2: p.muted, textColor3: p.meta,
      placeholderColor: p.muted, bodyColor: p.background, cardColor: p.surface, modalColor: p.overlay, popoverColor: p.overlay,
      borderColor: p.border, dividerColor: p.subtle,
    },
    Button: {
      ...base.Button,
      textColorPrimary: p.onPrimary, textColorHoverPrimary: p.onPrimary, textColorPressedPrimary: p.onPrimary, textColorFocusPrimary: p.onPrimary,
    },
    Empty: { textColor: p.muted },
    Menu: {
      ...base.Menu,
      itemColorActive: p.tint, itemColorActiveHover: p.tint,
      itemTextColorActive: p.selectedText, itemTextColorActiveHover: p.selectedText,
      itemIconColorActive: p.selectedText, itemIconColorActiveHover: p.selectedText,
    },
  };
}

export const identityTheme = themeOverrides('light');
export function themeVariables(mode: keyof typeof palettes) {
  const p = palettes[mode];
  const semantic = {
    'bg-canvas': p.background, 'bg-sidebar': p.sidebar, 'bg-content': p.content,
    surface: p.surface, 'surface-raised': p.overlay, text: p.text, 'text-heading': p.heading,
    'text-secondary': p.muted, 'text-meta': p.meta, 'border-subtle': p.subtle,
    'border-control': p.border, primary: p.brand, 'primary-hover': p.hover, 'primary-pressed': p.pressed,
    'on-primary': p.onPrimary, accent: p.accent, 'accent-bg': p.tint, 'accent-text': p.selectedText,
    success: p.success, 'success-bg': p.successTint, warning: p.warning, 'warning-bg': p.warningTint,
    danger: p.danger, 'danger-bg': p.dangerTint, unknown: p.unknown, 'unknown-bg': p.unknownTint,
    focus: p.focus, link: p.link, 'hover-bg': p.hoverTint, 'selected-bg': p.tint, 'selected-text': p.selectedText,
    'disabled-bg': p.disabledTint, 'disabled-text': p.disabled,
  };
  const layout = {
    'form-max-width':'48rem', 'page-padding':'1.5rem', 'page-padding-wide':'2rem', 'page-padding-mobile':'1rem',
    'section-gap':'1.5rem','page-header-gap':'1.25rem','grid-gap':'1rem','card-padding':'1.5rem','card-padding-dense':'1rem','field-gap':'1.25rem','toolbar-gap':'.75rem','action-gap':'.75rem','inline-gap':'.5rem',
    'font-size-caption':'.75rem','font-size-meta':'.8125rem','font-size-dense':'.875rem','font-size-body':'.875rem','font-size-reading':'.9375rem','font-size-h3':'1rem','font-size-h2':'1.25rem','font-size-h1':'1.5rem',
    'line-height-body':'1.5','line-height-reading':'1.625','line-height-meta':'1.6','font-weight-medium':'500','font-weight-semibold':'600',
  };
  return {
    ...Object.fromEntries(Object.entries(layout).map(([key,value])=>['--id-'+key,value])),
    ...Object.fromEntries([1,2,3,4,5,6,8,10,12].map(n=>['--id-space-'+n, n/4+'rem'])),
    ...Object.fromEntries(Object.entries(p).map(([key, value]) => ['--' + key, value])),
    ...Object.fromEntries(Object.entries(semantic).map(([key, value]) => ['--id-' + key, value])),
    '--id-radius-control': dimensions.radiusControl, '--id-radius-card': dimensions.radiusCard,
    '--id-radius-panel': dimensions.radiusPanel, '--id-control-md': dimensions.controlMedium,
    '--id-nav-width': dimensions.navWidth, '--id-nav-rail-width': dimensions.navRailWidth,
    '--id-content-max-width': dimensions.contentMaxWidth,
    '--id-card-surface': p.surface, '--id-card-radius': dimensions.radiusCard,
    '--id-button-primary-bg': p.brand, '--id-button-primary-text': p.onPrimary,
  };
}
