import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { StoreProvider } from './store/store';
import './styles/index.css';

// La vista previa se publica dentro de un esqueleto ajeno (sin lang): el lector de pantalla tiene que leer en español
document.documentElement.lang = 'es';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StoreProvider>
      {/* En pantallas anchas es el contenedor con scroll dentro del marco de teléfono (index.css) */}
      <div className="app-scroll">
        <App />
      </div>
    </StoreProvider>
  </React.StrictMode>,
);
