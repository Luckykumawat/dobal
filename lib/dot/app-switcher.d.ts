export const packageName: string;
export const dotApps: { id: string; name: string; url: string; icon: string }[];
export function defineAppSwitcher(tag?: string): void;

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'dot-app-switcher': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { current?: string };
    }
  }
}
