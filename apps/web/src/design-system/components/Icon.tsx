import type { SVGProps } from 'react';

/** A small, consistent line-icon set (1.5px strokes on a 20px grid). */
const PATHS = {
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  upload: 'M10 13V3.75M6.25 7.5 10 3.75l3.75 3.75M3.5 12.5v3.75h13V12.5',
  camera: 'M3 6.5h3l1.5-2h5l1.5 2h3v9.5H3zM10 13.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  spreadsheet: 'M3.5 3.5h13v13h-13zM3.5 8h13M3.5 12.5h13M8 3.5v13',
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
  search: 'M9 15.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5zM13.5 13.5 17 17',
  question:
    'M10 17.25a7.25 7.25 0 1 0 0-14.5 7.25 7.25 0 0 0 0 14.5zM7.9 7.9a2.2 2.2 0 1 1 3 2.05c-.55.22-.9.7-.9 1.3v.5M10 14v.1',
  chevronLeft: 'M12 4.5 6.5 10l5.5 5.5',
  chevronRight: 'M8 4.5l5.5 5.5L8 15.5',
  database:
    'M10 7c3.6 0 6.5-1 6.5-2.25S13.6 2.5 10 2.5 3.5 3.5 3.5 4.75 6.4 7 10 7zM3.5 4.75v10.5c0 1.25 2.9 2.25 6.5 2.25s6.5-1 6.5-2.25V4.75M3.5 10c0 1.25 2.9 2.25 6.5 2.25s6.5-1 6.5-2.25',
  photo: 'M3 6.5h3l1.5-2h5l1.5 2h3v9.5H3zM10 13.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  undo: 'M6.5 5 3 8.5 6.5 12M3.5 8.5h8a4.5 4.5 0 0 1 0 9H9',
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
