/**
 * identale 视觉设计方案 v1 · Naive UI 主题覆盖（由 docs/design/build 逻辑生成）
 * 用法：
 *   import { darkTheme } from 'naive-ui';
 *   import { identaleLight, identaleDark } from './naive-theme';
 *   <n-config-provider :theme="isDark ? darkTheme : null"
 *     :theme-overrides="isDark ? identaleDark : identaleLight">
 * 同时在 <html> 上设置 data-theme="light|dark" 并引入 tokens.css，保证自定义布局与 Naive 控件同源。
 */
import type { GlobalThemeOverrides } from 'naive-ui';

export const identaleLight: GlobalThemeOverrides = {
  "common": {
    "fontFamily": "\"PingFang SC\",\"Microsoft YaHei\",\"Hiragino Sans GB\",\"Noto Sans SC\",\"Noto Sans CJK SC\",-apple-system,BlinkMacSystemFont,\"Segoe UI\",system-ui,sans-serif",
    "fontFamilyMono": "\"JetBrains Mono\",\"SFMono-Regular\",\"Cascadia Mono\",Menlo,Consolas,\"Liberation Mono\",\"Noto Sans Mono CJK SC\",\"PingFang SC\",\"Microsoft YaHei\",monospace",
    "fontSize": "14px",
    "fontSizeMini": "12px",
    "fontSizeTiny": "12px",
    "fontSizeSmall": "13px",
    "fontSizeMedium": "14px",
    "fontSizeLarge": "15px",
    "fontSizeHuge": "16px",
    "lineHeight": "1.5714",
    "fontWeightStrong": "600",
    "borderRadius": "6px",
    "borderRadiusSmall": "4px",
    "heightTiny": "22px",
    "heightSmall": "28px",
    "heightMedium": "36px",
    "heightLarge": "44px",
    "heightHuge": "52px",
    "primaryColor": "#0F8167",
    "primaryColorHover": "#0B6A55",
    "primaryColorPressed": "#095544",
    "primaryColorSuppl": "#0B6A55",
    "infoColor": "#1D5FD1",
    "infoColorHover": "#1D5FD1",
    "infoColorPressed": "#1D5FD1",
    "infoColorSuppl": "#1D5FD1",
    "successColor": "#1B7A3A",
    "successColorHover": "#1B7A3A",
    "successColorPressed": "#1B7A3A",
    "successColorSuppl": "#1B7A3A",
    "warningColor": "#9A5300",
    "warningColorHover": "#9A5300",
    "warningColorPressed": "#9A5300",
    "warningColorSuppl": "#9A5300",
    "errorColor": "#C0262D",
    "errorColorHover": "#C0262D",
    "errorColorPressed": "#C0262D",
    "errorColorSuppl": "#C0262D",
    "textColorBase": "#182024",
    "textColor1": "#182024",
    "textColor2": "#4C575E",
    "textColor3": "#5F6B73",
    "textColorDisabled": "#8C979E",
    "placeholderColor": "#5F6B73",
    "iconColor": "#5F6B73",
    "bodyColor": "#F4F6F7",
    "cardColor": "#FFFFFF",
    "modalColor": "#FFFFFF",
    "popoverColor": "#FFFFFF",
    "tableColor": "#FFFFFF",
    "tableHeaderColor": "#ECEFF1",
    "inputColor": "#FFFFFF",
    "actionColor": "#ECEFF1",
    "hoverColor": "#F0F3F4",
    "tableColorHover": "#F0F3F4",
    "borderColor": "#DFE4E7",
    "dividerColor": "#E6EAEC",
    "boxShadow1": "0 1px 3px rgb(16 24 28 / 8%), 0 1px 2px rgb(16 24 28 / 4%)",
    "boxShadow2": "0 6px 16px -4px rgb(16 24 28 / 10%), 0 2px 4px rgb(16 24 28 / 4%)",
    "boxShadow3": "0 16px 40px -8px rgb(16 24 28 / 18%), 0 4px 8px rgb(16 24 28 / 6%)"
  },
  "Button": {
    "fontWeight": "500",
    "paddingMedium": "0 14px",
    "textColorPrimary": "#FFFFFF",
    "textColorHoverPrimary": "#FFFFFF",
    "textColorPressedPrimary": "#FFFFFF",
    "textColorFocusPrimary": "#FFFFFF"
  },
  "Card": {
    "borderRadius": "12px",
    "borderColor": "#E6EAEC",
    "paddingMedium": "20px 24px",
    "titleFontSizeMedium": "16px",
    "titleFontWeight": "600",
    "color": "#FFFFFF"
  },
  "Tag": {
    "borderRadius": "999px",
    "heightSmall": "22px",
    "fontSizeSmall": "12px"
  },
  "Tabs": {
    "tabTextColorActiveLine": "#182024",
    "barColor": "#0F8167",
    "tabFontWeightActive": "600",
    "tabTextColorLine": "#4C575E",
    "tabFontSizeMedium": "14px"
  },
  "DataTable": {
    "thColor": "#ECEFF1",
    "thTextColor": "#4C575E",
    "thFontWeight": "500",
    "tdColorHover": "#F0F3F4",
    "borderColor": "#E6EAEC",
    "fontSizeMedium": "14px",
    "thPaddingMedium": "10px 16px",
    "tdPaddingMedium": "12px 16px"
  },
  "Input": {
    "borderRadius": "6px",
    "border": "1px solid #7E8A92",
    "borderHover": "1px solid #0F8167",
    "borderFocus": "1px solid #0F8167",
    "boxShadowFocus": "0 0 0 3px #EAF8F3"
  },
  "Menu": {
    "itemHeight": "40px",
    "borderRadius": "8px",
    "itemColorActive": "#EAF8F3",
    "itemColorActiveHover": "#EAF8F3",
    "itemTextColorActive": "#0B6A55",
    "itemIconColorActive": "#0B6A55",
    "itemTextColorActiveHover": "#0B6A55",
    "itemIconColorActiveHover": "#0B6A55"
  },
  "Dialog": {
    "borderRadius": "16px",
    "padding": "24px"
  },
  "Drawer": {
    "bodyPadding": "24px"
  },
  "Steps": {
    "indicatorColorProcess": "#0F8167",
    "indicatorBorderColorProcess": "#0F8167",
    "indicatorColorFinish": "#EAF8F3",
    "indicatorBorderColorFinish": "#0F8167",
    "indicatorTextColorFinish": "#0B6A55",
    "splitorColorFinish": "#0F8167"
  },
  "Alert": {
    "borderRadius": "8px"
  },
  "Switch": {
    "railColorActive": "#0F8167"
  },
  "Tooltip": {
    "color": "#182024",
    "textColor": "#FFFFFF",
    "borderRadius": "6px"
  }
};

export const identaleDark: GlobalThemeOverrides = {
  "common": {
    "fontFamily": "\"PingFang SC\",\"Microsoft YaHei\",\"Hiragino Sans GB\",\"Noto Sans SC\",\"Noto Sans CJK SC\",-apple-system,BlinkMacSystemFont,\"Segoe UI\",system-ui,sans-serif",
    "fontFamilyMono": "\"JetBrains Mono\",\"SFMono-Regular\",\"Cascadia Mono\",Menlo,Consolas,\"Liberation Mono\",\"Noto Sans Mono CJK SC\",\"PingFang SC\",\"Microsoft YaHei\",monospace",
    "fontSize": "14px",
    "fontSizeMini": "12px",
    "fontSizeTiny": "12px",
    "fontSizeSmall": "13px",
    "fontSizeMedium": "14px",
    "fontSizeLarge": "15px",
    "fontSizeHuge": "16px",
    "lineHeight": "1.5714",
    "fontWeightStrong": "600",
    "borderRadius": "6px",
    "borderRadiusSmall": "4px",
    "heightTiny": "22px",
    "heightSmall": "28px",
    "heightMedium": "36px",
    "heightLarge": "44px",
    "heightHuge": "52px",
    "primaryColor": "#3BBD9B",
    "primaryColorHover": "#67C9A9",
    "primaryColorPressed": "#9EDFC8",
    "primaryColorSuppl": "#67C9A9",
    "infoColor": "#8DB6FF",
    "infoColorHover": "#8DB6FF",
    "infoColorPressed": "#8DB6FF",
    "infoColorSuppl": "#8DB6FF",
    "successColor": "#7FD99A",
    "successColorHover": "#7FD99A",
    "successColorPressed": "#7FD99A",
    "successColorSuppl": "#7FD99A",
    "warningColor": "#F6BE62",
    "warningColorHover": "#F6BE62",
    "warningColorPressed": "#F6BE62",
    "warningColorSuppl": "#F6BE62",
    "errorColor": "#FF9A9E",
    "errorColorHover": "#FF9A9E",
    "errorColorPressed": "#FF9A9E",
    "errorColorSuppl": "#FF9A9E",
    "textColorBase": "#E8EDEF",
    "textColor1": "#E8EDEF",
    "textColor2": "#AEB9BF",
    "textColor3": "#93A0A7",
    "textColorDisabled": "#66737A",
    "placeholderColor": "#93A0A7",
    "iconColor": "#93A0A7",
    "bodyColor": "#0C1114",
    "cardColor": "#141B1F",
    "modalColor": "#1A2227",
    "popoverColor": "#1A2227",
    "tableColor": "#141B1F",
    "tableHeaderColor": "#0F1518",
    "inputColor": "#141B1F",
    "actionColor": "#0F1518",
    "hoverColor": "#1F292E",
    "tableColorHover": "#1F292E",
    "borderColor": "#2C383E",
    "dividerColor": "#222C31",
    "boxShadow1": "0 1px 3px rgb(0 0 0 / 45%)",
    "boxShadow2": "0 8px 20px -6px rgb(0 0 0 / 60%)",
    "boxShadow3": "0 18px 44px -10px rgb(0 0 0 / 70%)"
  },
  "Button": {
    "fontWeight": "500",
    "paddingMedium": "0 14px",
    "textColorPrimary": "#04221B",
    "textColorHoverPrimary": "#04221B",
    "textColorPressedPrimary": "#04221B",
    "textColorFocusPrimary": "#04221B"
  },
  "Card": {
    "borderRadius": "12px",
    "borderColor": "#222C31",
    "paddingMedium": "20px 24px",
    "titleFontSizeMedium": "16px",
    "titleFontWeight": "600",
    "color": "#141B1F"
  },
  "Tag": {
    "borderRadius": "999px",
    "heightSmall": "22px",
    "fontSizeSmall": "12px"
  },
  "Tabs": {
    "tabTextColorActiveLine": "#E8EDEF",
    "barColor": "#3BBD9B",
    "tabFontWeightActive": "600",
    "tabTextColorLine": "#AEB9BF",
    "tabFontSizeMedium": "14px"
  },
  "DataTable": {
    "thColor": "#0F1518",
    "thTextColor": "#AEB9BF",
    "thFontWeight": "500",
    "tdColorHover": "#1F292E",
    "borderColor": "#222C31",
    "fontSizeMedium": "14px",
    "thPaddingMedium": "10px 16px",
    "tdPaddingMedium": "12px 16px"
  },
  "Input": {
    "borderRadius": "6px",
    "border": "1px solid #6B7A82",
    "borderHover": "1px solid #3BBD9B",
    "borderFocus": "1px solid #3BBD9B",
    "boxShadowFocus": "0 0 0 3px #10302A"
  },
  "Menu": {
    "itemHeight": "40px",
    "borderRadius": "8px",
    "itemColorActive": "#10302A",
    "itemColorActiveHover": "#10302A",
    "itemTextColorActive": "#5FD3B2",
    "itemIconColorActive": "#5FD3B2",
    "itemTextColorActiveHover": "#5FD3B2",
    "itemIconColorActiveHover": "#5FD3B2"
  },
  "Dialog": {
    "borderRadius": "16px",
    "padding": "24px"
  },
  "Drawer": {
    "bodyPadding": "24px"
  },
  "Steps": {
    "indicatorColorProcess": "#3BBD9B",
    "indicatorBorderColorProcess": "#3BBD9B",
    "indicatorColorFinish": "#10302A",
    "indicatorBorderColorFinish": "#3BBD9B",
    "indicatorTextColorFinish": "#5FD3B2",
    "splitorColorFinish": "#3BBD9B"
  },
  "Alert": {
    "borderRadius": "8px"
  },
  "Switch": {
    "railColorActive": "#3BBD9B"
  },
  "Tooltip": {
    "color": "#E8EDEF",
    "textColor": "#0C1114",
    "borderRadius": "6px"
  }
};

/** 状态色调：每个状态必须同时渲染图标 + 文字，颜色只做辅助。 */
export type StatusTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral' | 'unknown';
export const statusTones: Record<StatusTone, { light: { fg: string; bg: string; border: string }; dark: { fg: string; bg: string; border: string } }> = {
  "info": {
    "light": {
      "fg": "#1D5FD1",
      "bg": "#EAF1FD",
      "border": "#BCD2F8"
    },
    "dark": {
      "fg": "#8DB6FF",
      "bg": "#132542",
      "border": "#26406B"
    }
  },
  "success": {
    "light": {
      "fg": "#1B7A3A",
      "bg": "#E9F6EC",
      "border": "#B7E0C2"
    },
    "dark": {
      "fg": "#7FD99A",
      "bg": "#12301C",
      "border": "#245233"
    }
  },
  "warning": {
    "light": {
      "fg": "#9A5300",
      "bg": "#FFF4E0",
      "border": "#F3D19B"
    },
    "dark": {
      "fg": "#F6BE62",
      "bg": "#33240C",
      "border": "#5A4115"
    }
  },
  "danger": {
    "light": {
      "fg": "#C0262D",
      "bg": "#FDECEC",
      "border": "#F4C0C2"
    },
    "dark": {
      "fg": "#FF9A9E",
      "bg": "#3A1517",
      "border": "#62282B"
    }
  },
  "neutral": {
    "light": {
      "fg": "#4C575E",
      "bg": "#EEF1F2",
      "border": "#D3DADD"
    },
    "dark": {
      "fg": "#B4BFC5",
      "bg": "#1F282D",
      "border": "#36434A"
    }
  },
  "unknown": {
    "light": {
      "fg": "#6B3FC2",
      "bg": "#F2EDFC",
      "border": "#D6C8F3"
    },
    "dark": {
      "fg": "#C3A8FF",
      "bg": "#261B3E",
      "border": "#423165"
    }
  }
};

/** Task / Run / Delivery / Connection 四套状态机分别映射，禁止合并成一个“成功”标识。icon 为 lucide 图标名。 */
export const statusMap: Record<string, { label: string; icon: string; tone: StatusTone }> = {
  "task.queued": {
    "label": "排队中",
    "icon": "clock",
    "tone": "neutral"
  },
  "task.running": {
    "label": "执行中",
    "icon": "loader",
    "tone": "info"
  },
  "task.waiting_input": {
    "label": "等待补充信息",
    "icon": "message-question",
    "tone": "warning"
  },
  "task.waiting_approval": {
    "label": "等待确认",
    "icon": "hand",
    "tone": "warning"
  },
  "task.succeeded": {
    "label": "已完成",
    "icon": "check-circle",
    "tone": "success"
  },
  "task.failed": {
    "label": "失败",
    "icon": "x-circle",
    "tone": "danger"
  },
  "task.canceled": {
    "label": "已取消",
    "icon": "ban",
    "tone": "neutral"
  },
  "task.unknown": {
    "label": "结果待核对",
    "icon": "help-circle",
    "tone": "unknown"
  },
  "run.starting": {
    "label": "启动中",
    "icon": "play-dashed",
    "tone": "info"
  },
  "run.running": {
    "label": "运行中",
    "icon": "activity",
    "tone": "info"
  },
  "run.completed": {
    "label": "已结束",
    "icon": "flag",
    "tone": "success"
  },
  "run.interrupted": {
    "label": "已中断",
    "icon": "zap-off",
    "tone": "danger"
  },
  "run.timed_out": {
    "label": "已超时",
    "icon": "timer-off",
    "tone": "warning"
  },
  "delivery.pending": {
    "label": "待投递",
    "icon": "send",
    "tone": "neutral"
  },
  "delivery.sent": {
    "label": "已送达",
    "icon": "check-check",
    "tone": "success"
  },
  "delivery.partial": {
    "label": "部分送达",
    "icon": "alert-triangle",
    "tone": "warning"
  },
  "delivery.failed": {
    "label": "投递失败",
    "icon": "alert-octagon",
    "tone": "danger"
  },
  "delivery.unknown": {
    "label": "送达未知",
    "icon": "help-circle",
    "tone": "unknown"
  },
  "connection.verified": {
    "label": "已连接",
    "icon": "link",
    "tone": "success"
  },
  "connection.pending_verification": {
    "label": "待验证",
    "icon": "shield-question",
    "tone": "warning"
  },
  "connection.error": {
    "label": "连接异常",
    "icon": "unplug",
    "tone": "danger"
  },
  "connection.disabled": {
    "label": "已停用",
    "icon": "pause-circle",
    "tone": "neutral"
  },
  "connection.not_configured": {
    "label": "未接入",
    "icon": "minus-circle",
    "tone": "neutral"
  }
};
