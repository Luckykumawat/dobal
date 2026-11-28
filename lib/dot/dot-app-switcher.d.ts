declare module '@dot-workspace/app-switcher' {
  export const packageName: string;
  export const dotApps: { id: string; name: string; url: string; icon: string }[];
  export function defineAppSwitcher(tag?: string): void;
}

declare module '@dot-workspace/dot-id' {
  export const packageName: string;
  export const DOT_AUTH_ORIGIN: string;
  export interface DotUser { id: string; email: string; name: string }
  export interface DotSession { accessToken: string; expiresAt: number; user: DotUser; apps: string[] }
  export function createDotIdClient(opts?: { authOrigin?: string; appId?: string }): {
    getSession(): DotSession | null;
    getUser(): DotUser | null;
    getApps(): string[];
    signIn(opts?: { returnTo?: string }): void;
    signOut(): void;
    consumeCallback(): Promise<DotSession | null>;
    syncApps(): Promise<string[]>;
    onAuthChange(cb: (s: DotSession | null) => void): () => void;
  };
}

declare namespace React.JSX {
  interface IntrinsicElements {
    'dot-app-switcher': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      current?: string;
      apps?: string;
    };
  }
}
