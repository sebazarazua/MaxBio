import Link from 'next/link';
import { Workspace } from '@/components/workspace';
import { ConnectionStatus } from '@/components/connection-status';

export default function HomePage() {
  return (
    <Workspace>
      <p className="eyebrow">TU ESPACIO DE TRABAJO</p>
      <h1>¿Qué querés hacer?</h1>
      <p className="page-intro">
        Ingresá productos, consultá existencias o continuá el inventario del depósito.
      </p>
      <div className="home-cards">
        <Link href="/inventario/ingresos" className="home-card">
          <span>01</span>
          <h2>Ingresar productos</h2>
          <p>Escanear, preparar varios productos y confirmar una recepción.</p>
          <strong>Comenzar ingreso →</strong>
        </Link>
        <Link href="/identificar" className="home-card">
          <span>02</span>
          <h2>Identificar producto</h2>
          <p>Reconocer un código o asociarlo al producto correcto.</p>
          <strong>Identificar →</strong>
        </Link>
        <Link href="/stock" className="home-card">
          <span>03</span>
          <h2>Consultar stock</h2>
          <p>Disponibilidad, lotes, vencimientos e historial.</p>
          <strong>Ver stock →</strong>
        </Link>
        <Link href="/inventario/inicial" className="home-card">
          <span>04</span>
          <h2>Inventario inicial</h2>
          <p>Contar el depósito gradualmente y retomar sesiones guardadas.</p>
          <strong>Comenzar o retomar →</strong>
        </Link>
      </div>
      <ConnectionStatus />
    </Workspace>
  );
}
