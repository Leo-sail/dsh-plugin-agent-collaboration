/**
 * Native DSH icon artwork — **byte-identical** to the shipped primitives bundle
 * (`@deepseek-ai/dsh-client-ui-primitives/lib/index.js`, the `Icon*Artwork`
 * components). Every `d`, `rect` and `circle` value below was copied verbatim
 * out of that bundle by a generator script; nothing here is redrawn by hand.
 *
 * Native contract reproduced exactly:
 *   • `viewBox="0 0 16 16"`, `fill="none"`, `xmlns`, `aria-hidden="true"`
 *   • `width`/`height` default to the artwork's own default `size`
 *     (16 for most icons, **14 for the chevrons**)
 *   • `strokeWidth` is on the `<svg>` and inherited: Regular = 1, Medium = 1.3
 *   • paint is `stroke="currentColor"` / `fill="currentColor"`
 *
 * Sizing in the message action bar is driven by CSS, exactly like the native
 * `MessageIconActions.module.css` (`.action svg { 15px }`, `[data-clock=end]` →
 * `17px`), so the `size` prop here is only the standalone default.
 */
import type { CSSProperties } from 'react'

/** Props shared by every native artwork. */
export interface NativeIconProps {
  /** Standalone pixel size; native default is per-icon (16, or 14 for chevrons). */
  readonly size?: number | undefined
  readonly className?: string | undefined
  readonly style?: CSSProperties | undefined
}

/** Regular weight — the native `ICON_MEDIUM_STROKE` counterpart is 1.3. */
export const ICON_REGULAR_STROKE = 1
export const ICON_MEDIUM_STROKE = 1.3

/** 复制 / copy (Regular) — native default size 16. */
export function IconCopyOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      style={style}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      <rect x="1.52075" y="4.07373" width="10.3932" height="10.3932" rx="2" stroke="currentColor" />
      <path
        d="M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** 复制成功态 / copied (Regular) — native default size 16. */
export function IconCheckOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      style={style}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      <path d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4" stroke="currentColor" />
    </svg>
  )
}

/** 分支 / branch (Regular) — native default size 16. */
export function IconBranchOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      style={style}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      <path
        d="M1.01503 8.0001L5.6964 8.0001C6.41913 8.0001 6.78049 8.0001 7.12115 7.91951C7.4232 7.84804 7.71233 7.73014 7.97821 7.57C8.27809 7.38939 8.5364 7.13669 9.05303 6.63129L11.3281 4.40564"
        stroke="currentColor"
      />
      <path
        d="M1.01221 7.9999L5.6964 7.9999C6.41913 7.9999 6.78049 7.9999 7.12115 8.08049C7.4232 8.15196 7.71233 8.26986 7.97821 8.43C8.27809 8.61061 8.5364 8.86331 9.05303 9.36871L11.3281 11.5944"
        stroke="currentColor"
      />
      <circle cx="12.4502" cy="3.3079" r="1.56962" stroke="currentColor" />
      <circle cx="12.4502" cy="12.6921" r="1.56962" stroke="currentColor" />
    </svg>
  )
}

/** 用量 / token usage (Regular) — native default size 16. */
export function IconDatabaseOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      style={style}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      <path
        d="M13.1967 5.1869C13.7232 4.77378 14.0003 4.30517 14.0001 3.82819C14.0003 3.3512 13.7232 2.88259 13.1967 2.46947C12.6702 2.05635 11.9128 1.71328 11.0006 1.47475C10.0885 1.23621 9.05371 1.11062 8.00039 1.1106C6.94707 1.11057 5.9123 1.23612 5.00009 1.47461C4.08742 1.71301 3.32948 2.05604 2.80249 2.46919C2.2755 2.88235 1.99805 3.35106 1.99805 3.82819C1.99805 4.30531 2.2755 4.77402 2.80249 5.18718C3.32948 5.60033 4.08742 5.94336 5.00009 6.18176C5.9123 6.42025 6.94707 6.5458 8.00039 6.54578C9.05371 6.54575 10.0885 6.42016 11.0006 6.18163C11.9128 5.94309 12.6702 5.60002 13.1967 5.1869Z"
        stroke="currentColor"
      />
      <path d="M2 3.80371V11.7848" stroke="currentColor" />
      <path d="M14 3.80371V11.7848" stroke="currentColor" />
      <path
        d="M2 7.81396C2 8.60524 2.63214 9.36411 3.75736 9.92363C4.88258 10.4832 6.4087 10.7975 8 10.7975C9.5913 10.7975 11.1174 10.4832 12.2426 9.92363C13.3679 9.36411 14 8.60524 14 7.81396"
        stroke="currentColor"
      />
      <path
        d="M2 11.7847C2 12.6081 2.63214 13.3977 3.75736 13.98C4.88258 14.5622 6.4087 14.8893 8 14.8893C9.5913 14.8893 11.1174 14.5622 12.2426 13.98C13.3679 13.3977 14 12.6081 14 11.7847"
        stroke="currentColor"
      />
    </svg>
  )
}

/** 思考 / thinking (Regular) — native default size 16. */
export function IconThinkOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      style={style}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      <path
        d="M10.2854 5.71481C12.9673 8.39663 14.1182 11.5938 12.8562 12.8559C11.5942 14.1179 8.39706 12.9669 5.71518 10.2851C3.03333 7.60323 1.88236 4.40608 3.14441 3.14403C4.40644 1.882 7.6036 3.03297 10.2854 5.71481Z"
        stroke="currentColor"
      />
      <path
        d="M10.2854 10.2851C7.6036 12.9669 4.40644 14.1179 3.14441 12.8559C1.88236 11.5938 3.03333 8.39663 5.71518 5.71481C8.39706 3.03297 11.5942 1.882 12.8562 3.14403C14.1182 4.40608 12.9673 7.60323 10.2854 10.2851Z"
        stroke="currentColor"
      />
      <path
        d="M8.86291 8.0002C8.86291 8.47549 8.47762 8.86087 8.00224 8.86087C7.52694 8.86087 7.1416 8.47549 7.1416 8.0002C7.1416 7.52485 7.52694 7.13953 8.00224 7.13953C8.47762 7.13953 8.86291 7.52485 8.86291 8.0002Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** 折叠 / chevron-down (Regular) — native default size 14. */
export function IconChevronDownOutlineRegular({ size = 14, className, style }: NativeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      style={style}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      <path d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" stroke="currentColor" />
    </svg>
  )
}

/** 展开 / chevron-up (Regular) — native default size 14. */
export function IconChevronUpOutlineRegular({ size = 14, className, style }: NativeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      style={style}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      <path d="M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10" stroke="currentColor" />
    </svg>
  )
}

/** 右向折叠箭头 / chevron-right (Regular) — native default size 14. */
export function IconChevronRightOutlineRegular({ size = 14, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4" stroke="currentColor" />
    </svg>
  )
}

/** 进行中 / play (ToolDetails in_progress) (Regular) — native default size 16. */
export function IconPlayOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z" stroke="currentColor" />
      <path d="M10.3329 7.91346C10.3996 7.95195 10.3996 8.04818 10.3329 8.08667L6.78304 10.1362C6.71638 10.1747 6.63304 10.1266 6.63304 10.0496L6.63304 5.95055C6.63304 5.87357 6.71638 5.82546 6.78304 5.86395L10.3329 7.91346Z" stroke="currentColor" />
    </svg>
  )
}

/** 搜索 / search (variant=search: grep / glob / web_search) (Regular) — native default size 16. */
export function IconSearchOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z" stroke="currentColor" />
      <path d="M10.2991 10.3933L14.7783 14.8725" stroke="currentColor" />
    </svg>
  )
}

/** 读取文件 / browse (variant=read: read / web_fetch / read_image) (Regular) — native default size 16. */
export function IconBrowseOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M4.9375 5.90295H11.0625" stroke="currentColor" />
      <path d="M4.9375 9.02991H8.27841" stroke="currentColor" />
      <path d="M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z" fill="currentColor" />
    </svg>
  )
}

/** 命令 / api (variant=bash: bash / pwsh) (Regular) — native default size 14. */
export function IconApiOutlineRegular({ size = 14, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M3 4L7 8L3 12" stroke="currentColor" />
      <path d="M9 12H13" stroke="currentColor" />
    </svg>
  )
}

/** 写入编辑 / edit (variant=write / edit) (Regular) — native default size 16. */
export function IconEditOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z" fill="currentColor" />
      <path d="M7.7849 8.23878L13.888 2.13574" stroke="currentColor" />
    </svg>
  )
}

/** 代码 / code (variant=code, terminal_*) (Regular) — native default size 16. */
export function IconCodeOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M6.27612 1.5L4.52612 14.5" stroke="currentColor" />
      <path d="M11.4739 1.5L9.72388 14.5" stroke="currentColor" />
      <path d="M2.39868 5.5H14.0681" stroke="currentColor" />
      <path d="M1.93188 10.5H13.6013" stroke="currentColor" />
    </svg>
  )
}

/** 兜底 / sparkle (variant=others) (Regular) — native default size 16. */
export function IconSparkleRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z" stroke="currentColor" />
      <path d="M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z" stroke="currentColor" />
      <path d="M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z" stroke="currentColor" />
    </svg>
  )
}

/** 提问 / question (ask_user_question) (Regular) — native default size 14. */
export function IconQuestionOutlineRegular({ size = 14, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z" stroke="currentColor" />
      <path d="M5.75 6.69646C5.75 6.29865 5.88196 5.90976 6.12919 5.57899C6.37643 5.24821 6.72783 4.99041 7.13896 4.83817C7.5501 4.68593 8.0025 4.6461 8.43895 4.72371C8.87541 4.80132 9.27632 4.99289 9.59099 5.27419C9.90566 5.55549 10.12 5.91388 10.2068 6.30406C10.2936 6.69423 10.249 7.09866 10.0787 7.4662C9.90843 7.83373 9.62004 8.14787 9.25003 8.36889C9.19476 8.4019 9.13803 8.43262 9.08004 8.46099C8.52566 8.73217 8 9.20817 8 9.82532" stroke="currentColor" />
      <path d="M8 10.7416V11.7416" stroke="currentColor" />
    </svg>
  )
}

/** 清单 / checklist (todo_write, job_*, team_task_*) (Regular) — native default size 14. */
export function IconChecklistOutlineRegular({ size = 14, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M3.75 6.25C4.7165 6.25 5.5 5.4665 5.5 4.5C5.5 3.5335 4.7165 2.75 3.75 2.75C2.7835 2.75 2 3.5335 2 4.5C2 5.4665 2.7835 6.25 3.75 6.25Z" stroke="currentColor" />
      <path d="M7.5 4.5H13.5" stroke="currentColor" />
      <path d="M3.75 13.25C4.7165 13.25 5.5 12.4665 5.5 11.5C5.5 10.5335 4.7165 9.75 3.75 9.75C2.7835 9.75 2 10.5335 2 11.5C2 12.4665 2.7835 13.25 3.75 13.25Z" stroke="currentColor" />
      <path d="M7.5 11.5H13.5" stroke="currentColor" />
    </svg>
  )
}

/** 网页 / globe (web_search) (Regular) — native default size 14. */
export function IconGlobeOutlineRegular({ size = 14, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M7.99986 14.0887C11.3626 14.0887 14.0886 11.3627 14.0886 7.99998C14.0886 4.63727 11.3626 1.91125 7.99986 1.91125C4.63715 1.91125 1.91113 4.63727 1.91113 7.99998C1.91113 11.3627 4.63715 14.0887 7.99986 14.0887Z" stroke="currentColor" />
      <path d="M2.34619 8H13.6538" stroke="currentColor" strokeLinecap="square" />
      <path d="M7.99976 14.0889C9.23509 14.0889 10.1743 11.3629 10.1743 8.00006C10.1743 4.63739 9.23509 1.91138 7.99976 1.91138" stroke="currentColor" />
      <path d="M7.99973 14.0889C6.76445 14.0889 5.8252 11.3629 5.8252 8.00006C5.8252 4.63739 6.76445 1.91138 7.99973 1.91138" stroke="currentColor" />
    </svg>
  )
}

/** 队友 / users (teammate tools) (Regular) — native default size 16. */
export function IconUsersOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M6 8.25C7.51878 8.25 8.75 7.01878 8.75 5.5C8.75 3.98122 7.51878 2.75 6 2.75C4.48122 2.75 3.25 3.98122 3.25 5.5C3.25 7.01878 4.48122 8.25 6 8.25Z" stroke="currentColor" />
      <path d="M1 14.5C1 11.5 3.5 10.25 6 10.25C8.5 10.25 11 11.5 11 14.5" stroke="currentColor" />
      <path d="M10.5 2.9C11.65 3.35 12.45 4.35 12.45 5.5C12.45 6.65 11.65 7.65 10.5 8.1" stroke="currentColor" />
      <path d="M12.4 10.6C13.9 11.3 15 12.6 15 14.5" stroke="currentColor" />
    </svg>
  )
}

/** 定时 / clock (schedule_*) (Regular) — native default size 16. */
export function IconClockOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14Z" stroke="currentColor" />
      <path d="M8 4.31V8.46L11 10.08" stroke="currentColor" />
    </svg>
  )
}

/** 目标 / goal (*_goal) (Regular) — native default size 16. */
export function IconGoalOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5" stroke="currentColor" />
      <path d="M11.5 8C11.5001 8.69227 11.2948 9.36901 10.9102 9.94463C10.5257 10.5202 9.97901 10.9689 9.33944 11.2338C8.69986 11.4987 7.99609 11.5681 7.31712 11.433C6.63816 11.2979 6.01449 10.9645 5.52501 10.475C5.03548 9.98552 4.70209 9.36185 4.56702 8.68289C4.43195 8.00392 4.50127 7.30015 4.76619 6.66057C5.03112 6.021 5.47976 5.47436 6.05538 5.08978C6.631 4.70519 7.30774 4.49995 8.00001 4.5" stroke="currentColor" />
      <path d="M8.00024 7.99976L11.2 4.80005" stroke="currentColor" />
      <path d="M12.4719 5.62245C12.4246 5.66972 12.3569 5.69025 12.2913 5.67715L10.7814 5.37555C10.7022 5.35972 10.6402 5.29781 10.6244 5.2186L10.3228 3.70866C10.3097 3.6431 10.3302 3.57533 10.3775 3.52806L12.1826 1.723C12.2863 1.61929 12.4627 1.65879 12.5122 1.79684L12.9271 2.95225C12.9472 3.00847 12.9915 3.05272 13.0477 3.07291L14.2031 3.48774C14.3412 3.5373 14.3807 3.71368 14.277 3.81739L12.4719 5.62245Z" stroke="currentColor" />
    </svg>
  )
}

/** Cordis 插件 / cordis (cordis_*) (Regular) — native default size 14. */
export function IconCordisPluginOutlineRegular({ size = 14, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M3.16143 6.59068L1.75205 8.00006L3.10619 9.35419L2.39908 10.0613L0.832948 8.49517C0.559581 8.2218 0.559582 7.77831 0.832948 7.50494L2.45432 5.88357L3.16143 6.59068ZM8.49511 15.1671C8.22176 15.4405 7.77826 15.4404 7.50489 15.1671L5.93461 13.5968L6.64172 12.8897L8 14.248L9.40938 12.8386L10.1165 13.5457L8.49511 15.1671ZM15.1671 7.50494C15.4403 7.7782 15.4401 8.22179 15.1671 8.49517L13.652 10.0102L12.9449 9.30309L14.248 8.00006L12.8897 6.64178L13.5968 5.93467L15.1671 7.50494ZM9.35414 3.10624L8 1.7521L6.69696 3.05514L5.98986 2.34803L7.50489 0.833003C7.77828 0.559981 8.22186 0.559752 8.49511 0.833003L10.0612 2.39913L9.35414 3.10624Z" fill="currentColor" />
      <circle cx="8" cy="8" r="1.76221" stroke="currentColor" />
    </svg>
  )
}

/** 智能体预设 / agent preset (细节行兜底) (Regular) — native default size 16. */
export function IconAgentPresetOutlineRegular({ size = 16, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M6.51867 12.3282C7.29816 12.6011 8.16475 12.6514 9.02269 12.4216C9.57879 12.2726 10.0784 12.0185 10.5087 11.6888C10.7819 12.0555 11.1606 12.3304 11.5913 12.4805C10.9688 13.029 10.2149 13.4478 9.35911 13.6771C8.13946 14.0038 6.90632 13.8971 5.82126 13.4533C6.15821 13.1562 6.4021 12.7652 6.51867 12.3282ZM9.17629 2.89409C11.1101 3.34433 12.739 4.81872 13.2889 6.87043C13.4219 7.3665 13.4811 7.8649 13.4774 8.35466C13.0924 8.13213 12.6422 8.01837 12.1741 8.05276L12.1711 8.05257C12.1539 7.77199 12.109 7.48889 12.0334 7.20684C11.6363 5.72533 10.5048 4.6372 9.13549 4.22844C9.25559 3.87667 9.29214 3.49087 9.22309 3.09892C9.2108 3.02922 9.19451 2.96108 9.17629 2.89409ZM4.7311 3.89107L4.78302 4.11879C4.87648 4.4488 5.04146 4.74263 5.25579 4.98896C3.98078 6.01355 3.35848 7.72904 3.8089 9.41059C3.81828 9.44559 3.82866 9.48025 3.83885 9.51479C3.38217 9.61268 2.98548 9.84137 2.68107 10.1556C2.63414 10.022 2.5897 9.88632 2.55244 9.74726C1.93301 7.43489 2.86717 5.07173 4.71504 3.76697L4.7311 3.89107Z" fill="currentColor" />
      <path d="M7.99136 5.28105C8.87501 5.28105 9.59136 4.56471 9.59136 3.68105C9.59136 2.7974 8.87501 2.08105 7.99136 2.08105C7.1077 2.08105 6.39136 2.7974 6.39136 3.68105C6.39136 4.56471 7.1077 5.28105 7.99136 5.28105Z" stroke="currentColor" />
      <path d="M3.94009 12.9417C4.82374 12.9417 5.54009 12.2254 5.54009 11.3417C5.54009 10.458 4.82374 9.7417 3.94009 9.7417C3.05643 9.7417 2.34009 10.458 2.34009 11.3417C2.34009 12.2254 3.05643 12.9417 3.94009 12.9417Z" stroke="currentColor" />
      <path d="M12.0851 12.9417C12.9688 12.9417 13.6851 12.2254 13.6851 11.3417C13.6851 10.458 12.9688 9.7417 12.0851 9.7417C11.2015 9.7417 10.4851 10.458 10.4851 11.3417C10.4851 12.2254 11.2015 12.9417 12.0851 12.9417Z" stroke="currentColor" />
    </svg>
  )
}

/** 查看 / inspect (CodeBrackets, 默认 12px) (Regular) — native default size 12. */
export function IconInspectOutlineRegular({ size = 12, className, style }: NativeIconProps) {
  return (
    <svg width={size} height={size} className={className} style={style} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M4.67398 4.25061L1.36094 7.86484C1.29085 7.9413 1.29085 8.05866 1.36094 8.13513L4.67398 11.7494" stroke="currentColor" />
      <path d="M11.3262 4.25061L14.6392 7.86484C14.7093 7.9413 14.7093 8.05866 14.6392 8.13513L11.3262 11.7494" stroke="currentColor" />
      <path d="M9.56222 3.62573L6.43774 12.3743" stroke="currentColor" />
    </svg>
  )
}

/**
 * Overflow ("···") — the native top bar's more-menu control.
 * Verbatim from `IconEllipsisOutlineArtwork` (primitives).
 */
/**
 * Panel-left — the native sidebar toggle in the top bar.
 * Verbatim from `IconPanelLeftOutlineArtwork` (primitives).
 */
export function IconPanelLeftOutlineRegular({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z" stroke="currentColor" />
      <path d="M5.5 1.5V14.5" stroke="currentColor" />
    </svg>
  )
}

/**
 * Folder-open — the native files panel icon (`IconFolderOpenRegular`).
 * Verbatim from `IconFolderOpenArtwork` (primitives); three filled subpaths.
 */
export function IconFolderOpenRegular({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="currentColor" d="M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z" />
      <path fill="currentColor" d="M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z" />
      <path fill="currentColor" d="M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z" />
    </svg>
  )
}

/** Paperclip — command "file". Verbatim from IconPaperclipOutlineArtwork. */
export function IconPaperclipOutlineRegular({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M12.75 4.5V9.5C12.75 10.7598 12.2496 11.968 11.3588 12.8588C10.468 13.7496 9.25978 14.25 8 14.25C6.74022 14.25 5.53204 13.7496 4.64124 12.8588C3.75045 11.968 3.25 10.7598 3.25 9.5V5C3.25 4.13805 3.59241 3.3114 4.2019 2.7019C4.8114 2.09241 5.63805 1.75 6.5 1.75C7.36195 1.75 8.1886 2.09241 8.7981 2.7019C9.40759 3.3114 9.75 4.13805 9.75 5V9.5C9.75 9.96413 9.56563 10.4092 9.23744 10.7374C8.90925 11.0656 8.46413 11.25 8 11.25C7.53587 11.25 7.09075 11.0656 6.76256 10.7374C6.43437 10.4092 6.25 9.96413 6.25 9.5V5.5" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}


/** Send (paper plane) — command "feedback". Verbatim from IconSendOutlineArtwork. */
export function IconSendOutlineRegular({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M6.97211 1.94476C7.55785 1.35914 8.50767 1.35919 9.09343 1.94476L13.921 6.77228L13.2138 7.47939L8.38632 2.65187C8.19108 2.45682 7.87443 2.45677 7.67922 2.65187L2.74397 7.58711L2.03687 6.88L6.97211 1.94476Z" stroke="currentColor" />
      <path d="M7.97571 14.5732L8.02421 2.34139" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}

/** Download — command "export". Verbatim from IconDownloadOutlineArtwork. */
export function IconDownloadOutlineRegular({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M8 1.95317V10.0469" stroke="currentColor" strokeLinecap="round" />
      <path d="M4.25 6.29688L8 10.0469L11.75 6.29688" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}

/** Shield — command "permission". Verbatim SHIELD_OUTLINE_PATH (primitives). */
export function IconShieldOutlineRegular({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M6.80132 2.14853C7.70663 1.80917 8.70422 1.80919 9.60952 2.14859L14.1296 3.84317V7.11961C14.1296 11.6089 10.7615 13.5975 8.20543 14.5779C5.64931 13.5975 2.28052 11.6089 2.28052 7.11961V3.84317L6.80132 2.14853Z" stroke="currentColor" strokeLinejoin="round" />
    </svg>
  )
}

/** List-pen — command "plan" (IconPlanOutline aliases this artwork). Verbatim. */
export function IconPlanOutlineRegular({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M4.9375 5.90295H11.0625" stroke="currentColor" strokeLinecap="round" />
      <path d="M4.9375 9.02991H8.27841" stroke="currentColor" strokeLinecap="round" />
      <path d="M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V7.61328L13 8.68164V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H8.32812L7.39258 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5Z" stroke="currentColor" />
      <path d="M8.97212 14.3693C9.17511 14.5723 9.37811 14.7753 9.5811 14.9783C9.67012 14.8953 9.75914 14.8123 9.84815 14.7293C11.4505 13.2352 13.0528 11.7411 14.6551 10.247C14.7441 10.164 14.8331 10.081 14.9221 9.99803C14.5989 9.6748 14.2756 9.35157 13.9524 9.02834C13.8694 9.11736 13.7864 9.20637 13.7034 9.29539C12.2093 10.8977 10.7152 12.5 9.22113 14.1023C9.13813 14.1913 9.05513 14.2803 8.97212 14.3693Z" stroke="currentColor" />
      <path d="M11.6323 13.7841C11.6323 14.0395 11.6323 14.295 11.6323 14.5504C11.6812 14.5523 11.7301 14.5543 11.779 14.5562C12.659 14.5913 13.539 14.6263 14.419 14.6614C14.4679 14.6633 14.5168 14.6653 14.5657 14.6672C14.5657 14.3339 14.5657 14.0006 14.5657 13.6672C14.5168 13.6692 14.4679 13.6711 14.419 13.6731C13.539 13.7081 12.659 13.7432 11.779 13.7783C11.7301 13.7802 11.6812 13.7821 11.6323 13.7841Z" stroke="currentColor" />
    </svg>
  )
}

/**
 * Default command marker.
 *
 * Native's `compact` registers with no `icon` and the menu falls back to a plain
 * circle, so this shape stands in for that default rather than transcribing a
 * named artwork (no such artwork exists in the bundle).
 */
export function IconCircleOutlineRegular({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" />
    </svg>
  )
}

/** Plus — the composer's "+" glyph. Verbatim from IconPlusOutlineArtwork. */
export function IconPlusOutlineMedium({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1.3}>
      <path d="M8 2V14" stroke="currentColor" strokeLinecap="round" />
      <path d="M2 8H14" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Skill — the host's own skill glyph (`IconSkillOutlineArtwork`).
 * Note the artwork's natural viewBox is 17x17, not 16x16. Verbatim paths.
 */
export function IconSkillOutlineRegular({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 17 17" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M4.57788 5.77124H10.7029" stroke="currentColor" strokeLinecap="round" />
      <path d="M4.57788 8.89819H7.91879" stroke="currentColor" strokeLinecap="round" />
      <path fill="currentColor" d="M12.1404 1.19446C12.9442 1.19446 13.6404 1.81999 13.6404 2.64465V8.89856H12.6404V2.64465C12.6404 2.42015 12.4411 2.19446 12.1404 2.19446H3.14038C2.83968 2.19446 2.64038 2.42015 2.64038 2.64465V13.0929C2.64082 13.3172 2.84001 13.5421 3.14038 13.5421H8.88159V14.5421H3.14038C2.33675 14.5421 1.6408 13.9172 1.64038 13.0929V2.64465C1.64038 1.81999 2.33651 1.19446 3.14038 1.19446H12.1404Z" />
      <path d="M12.0051 15.1056C12.0051 13.6395 10.8166 12.451 9.35059 12.451C10.8166 12.451 12.0051 11.2626 12.0051 9.79651C12.0051 11.2626 13.1936 12.451 14.6597 12.451C13.1936 12.451 12.0051 13.6395 12.0051 15.1056Z" stroke="currentColor" strokeLinejoin="round" />
    </svg>
  )
}
