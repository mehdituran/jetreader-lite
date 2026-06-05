import React from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import App from './App';

const container = document.getElementById( 'jetreader-admin-app' );

if ( container ) {
    // React must own every child in its root. If WordPress/admin notices or an
    // older PHP loader leaves fallback markup in the container, React can later
    // try to remove a node that the browser/WordPress already moved/removed and
    // throw: "Failed to execute 'removeChild' on 'Node'".
    container.replaceChildren();
    const mount = document.createElement( 'div' );
    mount.className = 'jetreader-react-root';
    container.appendChild( mount );

    const root = ReactDOM.createRoot( mount );
    root.render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );
}