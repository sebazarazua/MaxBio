'use client';
import Link from 'next/link';
import Image from 'next/image.js';
import { usePathname } from 'next/navigation';
import { Icon } from './icon.tsx';
const links = [
  { href: '/', label: 'Inicio', icon: 'home' },
  { href: '/productos', label: 'Productos', icon: 'products' },
  { href: '/proveedores', label: 'Proveedores', icon: 'suppliers' },
  { href: '/clientes', label: 'Clientes', icon: 'clients' },
  { href: '/referencias', label: 'Listas de proveedores', icon: 'list' },
  { href: '/identificar', label: 'Identificar producto', icon: 'scan' },
  { href: '/remitos', label: 'Remitos', icon: 'document' },
  { href: '/stock', label: 'Stock', icon: 'stock' },
  { href: '/facturacion', label: 'Facturación', icon: 'billing' },
  { href: '/trazabilidad', label: 'Trazabilidad', icon: 'trace' },
  { href: '/configuracion', label: 'Configuración', icon: 'settings' },
] as const;
export function Navigation() {
  const path = usePathname();
  return (
    <aside className="sidebar">
      <Link href="/" className="brand" aria-label="MaxBio — Inicio">
        <span className="brand-mark" aria-hidden="true">
          <Image src="/brand/maxbio-logo.png" alt="" width={38} height={38} unoptimized />
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
