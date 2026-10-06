'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './icon';
const links = [
  { href: '/', label: 'Inicio', icon: 'home' },
  { href: '/productos', label: 'Productos', icon: 'products' },
  { href: '/proveedores', label: 'Proveedores', icon: 'suppliers' },
  { href: '/referencias', label: 'Listas de proveedores', icon: 'products' },
  { href: '/identificar', label: 'Identificar producto', icon: 'products' },
] as const;
export function Navigation() {
  const path = usePathname();
  return (
    <aside className="sidebar">
      <Link href="/" className="brand" aria-label="MaxBio — Inicio">
        <span className="brand-mark" aria-hidden="true">
          M
        </span>
        <span>
          MaxBio<span className="brand-description">Gestión de distribución</span>
        </span>
      </Link>
      <nav aria-label="Navegación principal">
        {links.map((link) => (
          <Link
            key={link.href}
            className="catalog-nav"
            href={link.href}
            aria-current={
              (link.href === '/' ? path === '/' : path.startsWith(link.href)) ? 'page' : undefined
            }
          >
            <Icon name={link.icon} />
            {link.label}
          </Link>
        ))}
      </nav>
      <p className="sidebar-note">
        El catálogo de tu organización,
        <br />a mano todos los días.
      </p>
    </aside>
  );
}
