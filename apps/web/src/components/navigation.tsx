import Link from 'next/link';
import { Icon } from './icon';

const upcoming = [
  { label: 'Productos', icon: 'products' },
  { label: 'Stock', icon: 'stock' },
  { label: 'Remitos', icon: 'document' },
  { label: 'Facturación', icon: 'billing' },
  { label: 'Trazabilidad', icon: 'trace' },
  { label: 'Clientes', icon: 'clients' },
  { label: 'Proveedores', icon: 'suppliers' },
] as const;

export function Navigation() {
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
        <Link className="nav-home" href="/" aria-current="page">
          <Icon name="home" />
          Inicio
        </Link>
        <p className="nav-label" id="upcoming-label">
          Próximas secciones
        </p>
        <ul className="nav-upcoming" aria-labelledby="upcoming-label">
          {upcoming.map(({ label, icon }) => (
            <li key={label}>
              <span aria-disabled="true">
                <Icon name={icon} />
                {label}
              </span>
            </li>
          ))}
        </ul>
      </nav>
      <p className="sidebar-note">
        Un espacio para organizar
        <br />
        el trabajo de todos los días.
      </p>
    </aside>
  );
}
