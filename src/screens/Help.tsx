import { PageHeader } from '../components/Sheet';
import { Suricata } from '../components/Suricata';

const TOPICS: [string, string][] = [
  ['Anotar un gasto', 'En Inicio tocá «Gasto» (o el + en Movimientos), escribí el monto y elegí el rubro. Listo: la fecha es hoy salvo que la cambies. Los rubros que más usás aparecen primero.'],
  ['Facturas y tickets', 'Tocá «Factura»: sacá una foto, elegila de tus fotos o subí el PDF. Pengar lee el comercio, la fecha, el total y cada renglón, y le pone un rubro a cada uno. Lo que todavía no reconoce se lo pregunta a Apple Intelligence, si tu iPhone lo tiene (o a Claude, si lo conectaste en Ajustes): esos renglones dicen «sugerido». Revisá, corregí lo que haga falta y guardá: podés separar la factura por rubro (por ejemplo, comida y limpieza del súper) o guardarla como un solo gasto. Lo que corregís, lo aprende para la próxima. La foto o el PDF quedan guardados: los ves desde el gasto («Ver factura») o en Más → Facturas y estados de cuenta, y desde ahí los podés compartir o guardar en Archivos.'],
  ['Estado de cuenta de la tarjeta', 'Tocá «Tarjeta» en Inicio y subí el PDF que te manda el banco (OCA, Visa o Master del BROU, Itaú, Santander, Scotiabank…) o la planilla que exporta; en el iPhone también le podés sacar una foto. Pengar junta las compras por comercio. La primera vez te pregunta de qué rubro es cada uno («Nuevos») y desde ahí aprende: el mes siguiente solo te pregunta por los comercios que no conoce; los demás van a «Ya los conozco», donde igual los podés cambiar. Si tu iPhone tiene Apple Intelligence (o conectaste Claude), te sugiere el rubro de los nuevos. Si algo no es un gasto, tocá «No es un gasto» y no te lo vuelve a preguntar. Las compras en dólares se pasan a pesos con la cotización que pongas. Lo que ya anotaste aparece en «Posibles repetidos» y no se guarda dos veces. Los pagos, el saldo y el reintegro de IVA no son gastos (el reintegro lo podés restar). Si ese mes ya está en tu planilla, te avisa para no contarlo dos veces. Cada compra queda como un gasto con su fecha y el estado de cuenta, en Más → Facturas y estados de cuenta.'],
  ['Gastos fijos', 'Lo que se repite todos los meses: el alquiler, la luz, Netflix, el sueldo. Al anotar un gasto prendé «Se repite todos los meses», o agregalos en Más → Gastos fijos (ahí también hay sugeridos según tu historial). Cuando llega el día, Inicio te muestra «Para anotar este mes»: tocá «Anotar» para revisar el monto (es una estimación, la luz no viene igual todos los meses), «Saltar» si este mes no corresponde o «Anotar todos» para cargarlos de una. Si ya lo anotaste por tu cuenta o con la factura, no te lo pide.'],
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
        <div className="flex justify-center"><Suricata pose="cara-curioso" size={120} flip /></div>
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
