type IconProps = { size?: number; className?: string };

const common = (size: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className,
  "aria-hidden": true,
});

export function Arrow({ size = 18, className }: IconProps) {
  return <svg {...common(size, className)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
}

export function Copy({ size = 17, className }: IconProps) {
  return <svg {...common(size, className)}><rect x="8" y="8" width="11" height="11" rx="1" /><path d="M16 8V5H5v11h3" /></svg>;
}

export function Check({ size = 17, className }: IconProps) {
  return <svg {...common(size, className)}><path d="m5 12 4 4L19 6" /></svg>;
}

export function Download({ size = 18, className }: IconProps) {
  return <svg {...common(size, className)}><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 20h16" /></svg>;
}

export function Menu({ size = 22, className }: IconProps) {
  return <svg {...common(size, className)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
}

export function Close({ size = 22, className }: IconProps) {
  return <svg {...common(size, className)}><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

export function External({ size = 16, className }: IconProps) {
  return <svg {...common(size, className)}><path d="M14 5h5v5M19 5l-8 8M19 14v5H5V5h5" /></svg>;
}

export function Key({ size = 18, className }: IconProps) {
  return <svg {...common(size, className)}><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8m-3 3 2 2" /></svg>;
}

export function File({ size = 18, className }: IconProps) {
  return <svg {...common(size, className)}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>;
}

export function Terminal({ size = 18, className }: IconProps) {
  return <svg {...common(size, className)}><rect x="3" y="4" width="18" height="16" rx="1" /><path d="m7 9 3 3-3 3m6 0h4" /></svg>;
}

export function Book({ size = 18, className }: IconProps) {
  return <svg {...common(size, className)}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5zM20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5z" /></svg>;
}
