declare module '@dot-workspace/app-switcher' {
  export const packageName: string;
  export const dotApps: { id: string; name: string; url: string; icon: string }[];
  export function defineAppSwitcher(tag?: string): void;
}

declare namespace React.JSX {
  interface IntrinsicElements {
    'dot-app-switcher': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { current?: string };
  }
}
