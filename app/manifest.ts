import type { MetadataRoute } from 'next';

// Web app manifest: used when Dobal is installed on a phone / desktop.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Dobal: your AI assistant',
    short_name: 'Dobal',
    description: 'Ask anything, chat with PDFs, and save explanations to your personal Notes.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0d0d0d',
    theme_color: '#0d0d0d',
    icons: [
      // White logo on a dark tile: visible on both light and dark wallpapers.
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Extra padding so Android can crop it into circles/squircles.
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      // Transparent single-color logo: Android "Themed icons" recolors it to match light/dark wallpaper.
      { src: '/icons/monochrome-512.png', sizes: '512x512', type: 'image/png', purpose: 'monochrome' },
    ],
  };
}
