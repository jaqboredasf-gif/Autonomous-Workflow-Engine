# PCC Design System v1

## Purpose
The Purchasing Control Center (PCC) design system is the visual and interaction source of truth for the product. It is optimized for high-information-density office purchasing workflows and touch-friendly field receiving workflows.

## Design Principles
- Professional, operational, and trustworthy.
- Dense on desktop; touch-friendly in the field.
- Blue is reserved primarily for primary action, selection, links, and focus.
- Status must never rely on color alone; text is always present.
- Tables prioritize scan speed over decoration.
- Receiving controls use large mobile touch targets.
- Destructive actions require explicit confirmation.
- Interfaces should minimize repeated typing and preserve operational context.
- Work remains visible until it is actually complete.

## Typography
Font family: Inter

| Style | Size | Line Height | Weight |
|---|---:|---:|---|
| Display | 32 | 40 | Bold |
| Heading 1 | 24 | 32 | Semi Bold |
| Heading 2 | 18 | 26 | Semi Bold |
| Body | 14 | 20 | Regular |
| Body Medium | 14 | 20 | Medium |
| Small | 12 | 16 | Regular |
| Label | 12 | 16 | Semi Bold |

## Color Tokens

### Neutral
- neutral/0: #FFFFFF
- neutral/50: #F8FAFC
- neutral/100: #F1F5F9
- neutral/200: #E2E8F0
- neutral/300: #CBD5E1
- neutral/500: #64748B
- neutral/700: #334155
- neutral/800: #1E293B
- neutral/900: #0F172A

### Action
- blue/50: #EFF6FF
- blue/500: #2563EB
- blue/600: #1D4ED8

### Success
- green/50: #F0FDF4
- green/500: #16A34A

### Warning
- amber/50: #FFFBEB
- amber/500: #D97706

### Danger
- red/50: #FEF2F2
- red/500: #DC2626

### Information
- sky/50: #F0F9FF
- sky/500: #0284C7

## Semantic Tokens
- surface/background = neutral/50
- surface/default = neutral/0
- surface/subtle = neutral/100
- text/primary = neutral/900
- text/secondary = neutral/500
- text/inverse = neutral/0
- border/default = neutral/200
- border/strong = neutral/300
- action/primary = blue/500
- action/primary-hover = blue/600
- action/soft = blue/50
- status/success = green/500
- status/success-bg = green/50
- status/warning = amber/500
- status/warning-bg = amber/50
- status/danger = red/500
- status/danger-bg = red/50
- status/info = sky/500
- status/info-bg = sky/50

## Spacing
4, 8, 12, 16, 20, 24, 32, 40, 48, 64 px

## Radius
4, 6, 8, 12, 16 px

## Elevation
Card shadow: subtle 0 2px 8px rgba(15,23,42,0.08)

## Responsive Rules
Desktop operational screens target 1280–1440 px widths.
Tables may use horizontal scroll before collapsing key business data.
Mobile field workflows should be usable at ~390 px width.
Primary mobile actions target at least 48 px height.
