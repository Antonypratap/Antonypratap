import type { SVGProps } from 'react';

/** A small, consistent line-icon set (1.5px strokes on a 20px grid). */
const PATHS = {
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  attention: 'M10 6.5v4.25M10 13.6v.15M10 2.75l7.5 13.5h-15z',
  arrowRight: 'M4 10h11M11 5.5 15.5 10 11 14.5',
  inbox: 'M3 11.5 5.25 4.5h9.5L17 11.5M3 11.5V16h14v-4.5M3 11.5h4l1 2h4l1-2h4',
  document: 'M5.5 2.75h6l3.25 3.25v11.25h-9.25zM11.25 2.75V6.25h3.5M8 10h4.5M8 13h4.5',
  person: 'M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4.25 16.75c.75-3 3-4.5 5.75-4.5s5 1.5 5.75 4.5',
  rules: 'M4 5.5h12M4 10h12M4 14.5h12M7 3.75v3.5M13 8.25v3.5M9.5 12.75v3.5',
  systems: 'M3.5 6.5 10 3l6.5 3.5L10 10zM3.5 10 10 13.5 16.5 10M3.5 13.5 10 17l6.5-3.5',
  audit: 'M10 17.25a7.25 7.25 0 1 0 0-14.5 7.25 7.25 0 0 0 0 14.5zM10 6v4l2.75 1.75',
  spark: 'M10 3v3.5M10 13.5V17M3 10h3.5M13.5 10H17',
  menu: 'M3.5 6.5h13M3.5 13.5h13',
  close: 'M5 5l10 10M15 5 5 15',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 20,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
