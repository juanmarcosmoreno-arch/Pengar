import { PageHeader } from '../components/Sheet';

const TOPICS: [string, string][] = [
  ['Anotar un gasto', 'En Inicio tocá «Gasto» (o el + en Movimientos), escribí el monto y elegí el rubro. Listo: la fecha es hoy salvo que la cambies. Los rubros que más usás aparecen primero.'],
  ['Facturas y tickets', 'Tocá «Factura»: sacá una foto, elegila de tus fotos o subí el PDF. Pengar lee el comercio, la fecha, el total y cada renglón, y le pone un rubro a cada uno. Revisá, corregí lo que haga falta y guardá: podés separar la factura por rubro (por ejemplo, comida y limpieza del súper) o guardarla como un solo gasto. Lo que corregís, lo aprende para la próxima. La foto o el PDF quedan guardados y los ves desde el gasto.'],
  ['Rubros y categorías', 'Los rubros son lo que elegís al anotar (Feria, UTE, Netflix). Cada uno pertenece a una categoría (Alimentación, Fijos…), que es la que tiene presupuesto y color en las gráficas. Todo se cambia en Más → Categorías y rubros. Las «palabras para las facturas» de cada rubro sirven para reconocerlo solo.'],
  ['Presupuesto', 'En Más → Presupuesto ponés cuánto pensás gastar por mes en cada categoría: un monto fijo o un porcentaje de lo que entra (como un diezmo del 10%). En Estadísticas → Mes ves lo real contra lo presupuestado.'],
  ['Estadísticas', '«Mes»: ingresos, gastos, presupuesto y el detalle de un mes. «Tendencias»: cómo cambian tus ingresos, tu ahorro y tus gastos en el tiempo, la distribución por categoría o por rubro, los promedios y los rubros que más pesan. «Incluir ahorro» suma o saca la categoría de ahorro de los gastos.'],
  ['Tu planilla', 'En Más → Ajustes → Importar podés traer una planilla de Excel: con un mes por columna (como presupuesto.xlsx) o con un movimiento por fila. Los meses importados aparecen como «totales de la planilla».'],
  ['Respaldo', 'Los datos viven solo en tu teléfono. En Ajustes podés exportar los movimientos a Excel o guardar un respaldo completo (con las facturas) en Archivos o iCloud Drive.'],
];

export function Help({ onBack }: { onBack: () => void }) {
  return (
    <div>
      <PageHeader title="Cómo se usa" onBack={onBack} />
      <div className="space-y-3 px-4 pb-10">
        {TOPICS.map(([t, body]) => (
          <section key={t} className="card p-4">
            <h2 className="text-xl">{t}</h2>
            <p className="mt-1 text-[17px] text-muted">{body}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
