import assert from 'node:assert/strict';
import test from 'node:test';
import { listarCotizaciones } from '../../../src/modules/asesor/asesor.repository.js';

for (const texto of ['PÉREZ GÓMEZ', 'MUÑOZ', 'MAT-123']) {
  /** Conserva el filtro Unicode parametrizado y el cotejo binario del número, sin modificar datos históricos. */
  test(`SPEC21 historial admite filtro Unicode sin convertir parámetros a ASCII: ${texto}`, async () => {
    const historica = { id: '1', nombres: 'María', apellidos: 'Muñoz', aportes: '[]' };
    const conexion = {
      /** Captura el SQL real y devuelve únicamente una fila sintética, sin abrir conexiones. */
      async execute(sql, parametros) {
        assert.match(sql, /CONVERT\(q\.numero USING utf8mb4\) COLLATE utf8mb4_bin LIKE \?/);
        assert.match(sql, /CONVERT\(c\.dni USING utf8mb4\) COLLATE utf8mb4_bin LIKE \?/);
        assert.match(sql, /CONCAT\(c\.nombres,' ',c\.apellidos\) LIKE \?/);
        assert.deepEqual(parametros.slice(4, 8), [texto, `%${texto}%`, `%${texto}%`, `%${texto}%`]);
        assert.equal(parametros[0], '12345678');
        return [[historica], []];
      },
    };
    const filas = await listarCotizaciones(conexion, '12345678', {
      cliente: texto, estado: '', dni: '', plan: '', desde: '', hasta: '', offset: 0,
    });
    assert.deepEqual(filas, [{ ...historica, aportes: [] }]);
    assert.equal(historica.aportes, '[]');
  });
}
