import { ConnectionStatus } from '@/components/connection-status';
import { Icon } from '@/components/icon';

export default function HomePage() {
  return (
    <div className="home-page">
      <p className="eyebrow">INICIO</p>
      <h1>
        Todo empieza por
        <br className="desktop-break" /> un lugar más organizado.
      </h1>
      <p className="intro">
        Bienvenido a MaxBio, el espacio que vamos a construir para simplificar la gestión de tu
        distribuidora.
      </p>
      <section className="welcome-panel" aria-labelledby="welcome-heading">
        <div className="panel-label">
          <span className="small-mark" aria-hidden="true" />
          Primeros pasos
        </div>
        <h2 id="welcome-heading">Estamos preparando tu espacio de trabajo</h2>
        <p>
          Las secciones se habilitarán de forma gradual. Por ahora, podés acceder al inicio y
          comprobar que el sistema esté conectado.
        </p>
        <div className="next-step">
          <Icon name="products" size={22} />
          <div>
            <span className="next-step-label">Próxima etapa</span>
            <strong>Organizar el catálogo de productos</strong>
          </div>
        </div>
      </section>
      <ConnectionStatus />
      <p className="home-note">
        Las secciones del menú marcadas como próximas todavía no están disponibles.
      </p>
    </div>
  );
}
