import Link from 'next/link';
import { Workspace } from '@/components/workspace';
import { ConnectionStatus } from '@/components/connection-status';

export default function HomePage() {
  return (
    <Workspace>
      <p className="eyebrow">TU ESPACIO DE TRABAJO</p>
      <h1>Catálogo MaxBio</h1>
      <p className="page-intro">Encontrá los productos y proveedores con los que trabajás.</p>
      <div className="home-cards">
        <Link href="/productos" className="home-card">
          <span>01</span>
          <h2>Productos</h2>
          <p>Buscar por nombre o código. Consultar y organizar el catálogo.</p>
          <strong>Ver productos →</strong>
        </Link>
        <Link href="/proveedores" className="home-card">
          <span>02</span>
          <h2>Proveedores</h2>
          <p>Datos de contacto y productos que ofrece cada proveedor.</p>
          <strong>Ver proveedores →</strong>
        </Link>
      </div>
      <ConnectionStatus />
    </Workspace>
  );
}
