import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function RadarIcon(props: IconProps) {
  return <IconBase {...props}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /><path d="M12 3v3M21 12h-3M12 21v-3M3 12h3M14.1 9.9l4-4" /></IconBase>;
}

export function GridIcon(props: IconProps) {
  return <IconBase {...props}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></IconBase>;
}

export function PlusIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 5v14M5 12h14" /></IconBase>;
}

export function PulseIcon(props: IconProps) {
  return <IconBase {...props}><path d="M3 12h4l2.2-6 4.1 12 2.1-6H21" /></IconBase>;
}

export function ArrowIcon(props: IconProps) {
  return <IconBase {...props}><path d="M5 12h14M13 6l6 6-6 6" /></IconBase>;
}

export function ExternalIcon(props: IconProps) {
  return <IconBase {...props}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></IconBase>;
}

export function PlayIcon(props: IconProps) {
  return <IconBase {...props}><path d="m8 5 11 7-11 7Z" /></IconBase>;
}

export function PauseIcon(props: IconProps) {
  return <IconBase {...props}><path d="M9 5v14M15 5v14" /></IconBase>;
}

export function CheckIcon(props: IconProps) {
  return <IconBase {...props}><path d="m5 12 4 4L19 6" /></IconBase>;
}

export function XIcon(props: IconProps) {
  return <IconBase {...props}><path d="m6 6 12 12M18 6 6 18" /></IconBase>;
}

export function CameraIcon(props: IconProps) {
  return <IconBase {...props}><path d="M4 8h3l2-3h6l2 3h3v11H4Z" /><circle cx="12" cy="13" r="3" /></IconBase>;
}

export function ShieldIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 3 5 6v5c0 4.5 2.8 8.5 7 10 4.2-1.5 7-5.5 7-10V6Z" /><path d="m9 12 2 2 4-4" /></IconBase>;
}

export function ClockIcon(props: IconProps) {
  return <IconBase {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></IconBase>;
}

export function BoxIcon(props: IconProps) {
  return <IconBase {...props}><path d="m4 7 8-4 8 4-8 4Z" /><path d="M4 7v10l8 4 8-4V7M12 11v10" /></IconBase>;
}

export function MenuIcon(props: IconProps) {
  return <IconBase {...props}><path d="M4 7h16M4 12h16M4 17h16" /></IconBase>;
}
