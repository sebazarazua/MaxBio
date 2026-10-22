import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'MaxBio | Inicio', template: '%s | MaxBio' },
  description: 'Espacio de trabajo de MaxBio.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-AR">
      <body>
        <a href="#main-content" className="skip-link">
          Ir al contenido principal
        </a>
        <div className="auth-shell">
          <main id="main-content" tabIndex={-1}>
            {children}
          </main>
          <footer className="auth-footer">MaxBio · Gestión de distribución</footer>
        </div>
      </body>
    </html>
  );
}
