<p align="center">
  <img src="frontend/public/favicon.svg" width="64" height="64" alt="">
</p>

<h1 align="center">randl</h1>

<p align="center">
  <b>Seguimiento de experimentos autoalojado para el SDK de W&amp;B para Python.</b><br>
  Conserve su código con <code>wandb.init()</code> y <code>wandb.log()</code>; envíe las ejecuciones a su propio servidor.<br>
  Explórelas en el tablero, automatícelas con la CLI <code>randl</code> o consulte al Asistente integrado.
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-Hans.md">简体中文</a> ·
  <a href="README.zh-Hant.md">繁體中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.fr.md">Français</a> ·
  <b>Español</b>
</p>

![Un espacio de trabajo de randl que compara doce ejecuciones de un barrido de la tasa de aprendizaje](.github/assets/readme/hero.webp)

randl ("rewards and losses", recompensas y pérdidas) es un sistema de seguimiento de
experimentos que usted mismo ejecuta. El paquete `wandb` estándar registra datos en él
cuando define dos variables de entorno, y un tablero web rápido muestra sus métricas,
contenido multimedia y artefactos a medida que llegan. El mismo espacio de trabajo responde
a la línea de comandos `randl` y a un Asistente de IA que funciona con el proveedor de
modelos que usted elija. Todo permanece en su equipo o en su servidor: un proceso de
Node.js, una base de datos SQLite y una carpeta de archivos.

## Por qué randl

- **Reemplazo directo para el SDK de W&B.** Apunte `WANDB_BASE_URL` a randl y conserve
  su código de entrenamiento. Las métricas, la configuración, los resúmenes, las
  imágenes, los videos, el audio, las tablas, los histogramas, los archivos, los
  artefactos, la reanudación, la sincronización sin conexión y las solicitudes de
  detención funcionan con el SDK real.
- **Es suyo.** Sin cuenta y sin servicio en la nube. De forma predeterminada escucha en
  `127.0.0.1`; con una clave de API y un proxy inverso HTTPS puede acceder a él desde
  cualquier lugar.
- **Un tablero completo.** Espacios de trabajo con vistas guardadas, agrupación, suavizado,
  métricas calculadas, paneles multimedia, una tabla de ejecuciones, artefactos y
  resúmenes de proyectos. La interfaz está disponible en siete idiomas.
- **Un Asistente que configura el espacio de trabajo por usted.** Pida lo que quiera en
  lenguaje natural, por ejemplo "compara mis tres mejores ejecuciones" o "agrega un
  panel para la pérdida de valor agrupada por tasa de aprendizaje", y el Asistente lee
  sus ejecuciones y crea las vistas, los paneles y las selecciones de ejecuciones con las
  mismas herramientas que el tablero y la CLI. Use su propio proveedor de modelos: Anthropic,
  OpenAI, Google, OpenRouter y muchos más. No puede eliminar un proyecto sin su
  confirmación.
- **Automatizable desde la línea de comandos.** La CLI `randl` administra proyectos,
  ejecuciones, vistas, paneles, selecciones de ejecuciones, artefactos y plugins en un
  servidor local o remoto, e imprime JSON para `jq`, scripts y CI. `randl tools` describe
  cada herramienta con un JSON Schema, de modo que agentes de programación como Claude
  Code o Codex también pueden controlar randl.
- **Rápido con ejecuciones largas y con muchas ejecuciones.** Los gráficos se cargan al
  desplazarse hasta ellos, obtienen aproximadamente tantos puntos como píxeles tiene el
  gráfico (el mínimo y el máximo de cada intervalo, para que los picos sigan visibles) y
  se refinan al hacer zoom o ampliarlos.
- **Almacenamiento ligero.** El historial se guarda sin pérdidas en bloques comprimidos.
  En nuestra prueba de rendimiento sintética, la base de datos completa, índices
  incluidos, ocupó aproximadamente una quinta parte del espacio del historial JSON que
  contiene.

## Inicio rápido

Necesita [Node.js](https://nodejs.org/) 22.19 o posterior. Python solo es necesario para
su código de entrenamiento.

**1. Instale e inicie randl.** Desde un clon de este repositorio:

```sh
npm ci
npm run build
npm start
```

El servidor escucha en [http://127.0.0.1:8742](http://127.0.0.1:8742) y guarda sus datos
en `.data/`. Use `npm start -- --port 9000 --data-dir /path/to/data` para cambiar
cualquiera de los dos.

**2. Apunte el SDK de W&B al servidor.** En el shell que ejecuta su código de
entrenamiento:

```sh
pip install wandb numpy pillow moviepy
export WANDB_BASE_URL=http://127.0.0.1:8742
export WANDB_API_KEY=0000000000000000000000000000000000000000
```

La clave de marcador de posición funciona con un servidor local que no tiene ninguna
clave de API configurada. `moviepy` solo es necesario para registrar videos a partir de
arreglos de NumPy.

**3. Registre una ejecución** como ya lo hace:

```python
import numpy as np
import wandb

with wandb.init(project="quickstart", config={"lr": 3e-4, "batch_size": 64}) as run:
    for step in range(200):
        loss = 2.0 * np.exp(-step / 60) + 0.05 * np.random.rand()
        metrics = {"train/loss": loss, "train/accuracy": 1 - loss / 2.1}
        if step % 50 == 0:
            image = np.random.randint(0, 255, (64, 64, 3), dtype=np.uint8)
            metrics["samples"] = wandb.Image(image, caption=f"step {step}")
            frames = np.random.randint(0, 255, (16, 3, 64, 64), dtype=np.uint8)  # time, channel, H, W
            metrics["rollout"] = wandb.Video(frames, fps=8, format="mp4")
        run.log(metrics)
```

**4. Abra [http://127.0.0.1:8742](http://127.0.0.1:8742).** La ejecución aparece bajo la
entidad `local` en el proyecto **quickstart**, con un gráfico para cada métrica y
paneles para las imágenes y el video. **Conectar SDK**, en el encabezado del proyecto,
muestra esta configuración con el proyecto ya completado.

Otras formas de conectarse:

- `wandb login --relogin --host http://127.0.0.1:8742 KEY` guarda randl como el host de
  W&B predeterminado para su cuenta de usuario, en lugar de usar variables de entorno.
- Las ejecuciones registradas con `WANDB_MODE=offline` se suben con
  `wandb sync wandb/offline-run-*` una vez definidas las variables.
- Una ejecución iniciada sin entidad usa la entidad predeterminada del servidor,
  `local`. Inicie el servidor con `--entity NAME` (o `RANDL_ENTITY=NAME`) para usar
  otra, como su nombre de usuario de W&B.

## Recorrido

### Espacios de trabajo al día con sus ejecuciones

El espacio de trabajo compara todas las ejecuciones visibles en secciones de paneles que
se actualizan en vivo a medida que llegan los datos. Muestre, oculte o **aísle**
ejecuciones con un clic o arrastrando sobre la lista de ejecuciones (se pueden aislar
varias ejecuciones a la vez), fije hasta 20 ejecuciones en la parte superior y asigne a
las ejecuciones sus propios colores. Los paneles, las selecciones de ejecuciones, los
colores, los filtros y la configuración de los gráficos se guardan en **vistas**, con
deshacer y rehacer.

- Paneles de líneas, áreas, áreas apiladas, áreas porcentuales, barras, dispersión,
  dispersión del historial, coordenadas paralelas, histograma, tabla, imágenes, audio y
  video.
- Pase el puntero o use el teclado para inspeccionar valores; el cursor y la ejecución
  bajo el puntero están vinculados entre los paneles y la lista de ejecuciones.
- Arrastre sobre un gráfico para hacer zoom; solo se obtienen los puntos que faltan.
- Cuatro métodos de suavizado (EMA, EMA ponderada por tiempo, gaussiano y media móvil
  centrada), ejes logarítmicos, rangos fijos y **Excluir valores atípicos del rango Y**,
  definidos por panel, por sección o para todo el espacio de trabajo.
- Exporte un panel como PNG o sus datos como CSV.

### Agrupación y agregación

![Retorno por episodio agrupado por tasa de aprendizaje, con la tarjeta emergente que muestra la media de cada grupo](.github/assets/readme/grouped.webp)

Agrupe los gráficos por cualquier valor de configuración, etiqueta o campo de la
ejecución para representar la media, la mediana, el mínimo o el máximo de cada grupo con
una banda de dispersión. Al pasar el puntero se muestra el nombre de cada grupo y
cuántas ejecuciones promedia. La lista de ejecuciones y la tabla de ejecuciones se
pueden agrupar de forma independiente de los gráficos.

### Un gráfico por ejecución

![Diseño de cuadrícula: un gráfico pequeño por ejecución, con los rangos X e Y compartidos](.github/assets/readme/grid.webp)

**Diseño → Cuadrícula** dibuja cada ejecución o grupo en su propio gráfico pequeño con
ejes compartidos, y **Coverflow** los muestra de uno en uno. El puntero, los cursores y
el zoom permanecen vinculados entre las celdas.

### Imágenes, video y audio

<table>
  <tr>
    <td width="50%"><img src=".github/assets/readme/media.webp" alt="Muestras de imágenes de una ejecución en cada paso registrado, del ruido a sprites nítidos"></td>
    <td width="50%"><img src=".github/assets/readme/coverflow.webp" alt="Coverflow de muestras de imágenes en el tema oscuro"></td>
  </tr>
</table>

Los paneles multimedia muestran cada archivo registrado como un elemento, ya sea para
todas las ejecuciones en un paso o para una ejecución a lo largo de sus pasos, con un
control deslizante de pasos compartido por la sección. Las imágenes y las portadas de
los videos solo se cargan para los elementos visibles. Los videos se reproducen
automáticamente sin sonido y en bucle mientras están en pantalla (ambas opciones se
pueden desactivar) y se transmiten con posibilidad de saltar a cualquier punto.
**Coverflow** presenta los archivos de uno en uno, y Enter sobre un elemento lo abre en
pantalla completa.

### Métricas calculadas

![El editor de paneles con una métrica calculada que divide dos métricas registradas](.github/assets/readme/computed.webp)

Represente una fórmula como `${rollout/pole_falls} / ${rollout/episodes}` junto a las
métricas registradas. Las fórmulas se evalúan por cada registro del historial antes de
la agrupación y el suavizado, con resaltado de sintaxis y autocompletado de nombres de
métricas y funciones `Math.`. randl las analiza por sí mismo; no se ejecuta JavaScript.

### Tabla de ejecuciones

![La tabla de ejecuciones agrupada por tasa de aprendizaje con tres ejecuciones seleccionadas](.github/assets/readme/table.webp)

Busque, filtre, ordene y agrupe ejecuciones, elija hasta 32 columnas entre los campos de
configuración, de resumen y de la ejecución, y seleccione ejecuciones para etiquetarlas,
detenerlas o eliminarlas. Las ejecuciones eliminadas se pueden restaurar desde la
configuración del proyecto.

### Resumen del proyecto y estado del servidor

![Un resumen de proyecto con una ejecución en curso, los estados de las ejecuciones y el uso de almacenamiento](.github/assets/readme/overview.webp)

El resumen de cada proyecto enumera las ejecuciones en curso con su tiempo de ejecución
en vivo, cuenta las ejecuciones por estado, totaliza el tiempo de cómputo y el
almacenamiento, y enlaza a las ejecuciones más grandes y más recientes. La página
**Servidor** muestra en gráficos las solicitudes, los tiempos de respuesta, los bytes
transferidos y las tasas de error de la última hora, junto con la memoria y el tamaño de
la base de datos.

### Pregunte al Asistente

![El Asistente creando una vista con las mismas herramientas que usa la CLI](.github/assets/readme/assistant.webp)

Abra **Asistente** en el encabezado y describa lo que quiere ver. El Asistente sabe qué
proyecto y qué vista tiene abiertos, consulta ejecuciones, métricas y vistas guardadas, y
hace el cambio por sí mismo. Por ejemplo:

- _"Compara mis tres mejores ejecuciones en retorno por episodio."_ Lee los resúmenes de
  las ejecuciones, crea una vista con un gráfico del retorno por episodio y aísla las tres
  ejecuciones.
- _"Agrega un panel para la pérdida de valor agrupada por tasa de aprendizaje."_ Agrega un
  gráfico de líneas a la vista abierta, agrupado por el valor de configuración
  `learning_rate`.
- _"Etiqueta las ejecuciones interrumpidas como inestables y ocúltalas."_ Etiqueta las
  ejecuciones y actualiza la selección de ejecuciones de la vista.

Cada llamada a herramienta aparece en la conversación mientras se ejecuta, y el resultado
es una vista guardada normal que puede seguir editando a mano. Las conversaciones se
guardan en **Historial de conversaciones**. Las ejecuciones que elimina el Asistente se
pueden restaurar desde la configuración del proyecto. Eliminar un proyecto es la única
acción que requiere su confirmación: una tarjeta en la conversación espera a que usted
escriba el nombre del proyecto, y el modelo no puede confirmarlo.

El Asistente se basa en el agente de programación Pi y solo carga las herramientas de
administración de randl, sin acceso al shell ni a los archivos. Elija un proveedor y un
modelo en **Configuración de la aplicación → Asistente**: guarde una clave de API de
Anthropic, OpenAI, Google, Mistral, OpenRouter u otro proveedor compatible con Pi, inicie
sesión con Pi en el servidor o agregue su propio punto de conexión al `models.json` de Pi.
Las solicitudes al modelo y los resultados de las herramientas se envían al proveedor del
modelo.

### Automatice con la CLI de randl

![Una sesión de terminal que crea una vista, agrega un panel, aísla ejecuciones y consulta al Asistente](.github/assets/readme/cli.webp)

Todo lo que puede hacer el Asistente también es un comando `randl`, además de los
artefactos, los plugins y la administración de proyectos. Los comandos imprimen JSON, así
que se combinan con `jq`, scripts de shell y trabajos de CI, y funcionan igual con un
servidor remoto. Esta sesión crea una vista a mano:

```sh
alias randl="node $PWD/backend/dist/cli.js"  # once, from the repository root

VIEW=$(randl views create --project demo/cartpole-ppo --name "Best learning rate" | jq -r .id)
randl panels add --view $VIEW --metric charts/episodic_return
randl runs --project demo/cartpole-ppo \
  | jq '[.[] | select(.group_name == "lr=0.0003") | .id]' \
  | randl select --view $VIEW --solo-file -
```

`randl tools` enumera todas las herramientas de administración con un JSON Schema de sus
argumentos, y `randl tool NAME --json ARGUMENTS` llama a cualquiera de ellas, incluidas
las opciones que los comandos más cortos omiten:

```sh
randl tools | jq -r '.tools[].name'
randl tool panel_add --json '{"view": "'$VIEW'", "plugin": "line", "metric": "losses/value_loss", "settings": {"groupBy": "config.learning_rate"}}'
```

`randl agent` envía una solicitud al Asistente e imprime su respuesta, con cada llamada a
herramienta en la salida de error estándar. Rechaza las eliminaciones de proyectos, salvo
que permita una con `--confirm-delete-project entity/project`.

```sh
randl agent 'Compare my three best runs on episodic return'
```

**Con agentes de programación.** Los comandos nunca piden datos de forma interactiva,
imprimen JSON e informan de los errores en la salida de error estándar con un código de
salida distinto de cero, de modo que agentes de programación como Claude Code o Codex
pueden usar randl directamente. Indique al agente que lea `randl --help` y `randl tools`
y luego pídale, por ejemplo, que configure una vista para el experimento que acaba de
lanzar.

Las capturas de pantalla usan un modelo local de sustitución; las llamadas a herramientas
se ejecutaron contra un servidor real.

### En cualquier pantalla, en su idioma

<table>
  <tr>
    <td width="34%"><img src=".github/assets/readme/mobile.webp" alt="El espacio de trabajo en un teléfono"></td>
    <td>
      El diseño se adapta a las pantallas de teléfono, y los gráficos funcionan de forma
      táctil: mantenga presionado y luego arrastre para hacer zoom.<br><br>
      Los temas claro y oscuro siguen la configuración de su sistema o su elección, con
      una selección de colores de acento. Los colores de las ejecuciones usan la paleta
      de W&amp;B en ambos temas.<br><br>
      La interfaz está disponible en inglés, chino simplificado, chino tradicional
      (Taiwán), japonés, coreano, francés y español. Los nombres de las ejecuciones, las
      claves de las métricas y otros datos registrados siempre se muestran tal como se
      registraron.
    </td>
  </tr>
</table>

## Compatibilidad con W&B

randl implementa las partes del protocolo de W&B que el SDK para Python usa para el
seguimiento. Se prueba con el paquete `wandb` **0.30.0** real, con y sin clave de API.

| Funciona                                                                                     | Notas                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `wandb.init`, `run.log`, configuración, resumen, etiquetas, grupos, notas                    |                                                                                |
| Imágenes, video, audio, tablas e histogramas                                                 | Se muestran en paneles multimedia, de tabla y de histograma                    |
| Métricas de paso y métricas ocultas de `define_metric`                                       | El SDK calcula la agregación del resumen                                       |
| Finalización, fallo, reanudación (`resume="allow"` / `"must"`) y detención desde el tablero  | Las ejecuciones sin contacto durante 10 minutos se marcan como interrumpidas   |
| Archivos de la ejecución, metadatos del entorno, métricas del sistema y registros de consola |                                                                                |
| Artefactos: registro, versiones, alias, uso y descarga                                       | Archivos de hasta 10 GiB cada uno                                              |
| `wandb login --host`, `WANDB_MODE=offline` con `wandb sync`                                  |                                                                                |
| `run.alert()`                                                                                | Se muestra en la página de la ejecución; sin notificaciones por correo ni chat |
| `wandb.Api()` para leer ejecuciones                                                          | `Api().run(...)` y `Api().runs("entity/project")` sin filtros                  |

No se admiten: Reports, Sweeps, Registry, Launch, Weave, gráficos personalizados de Vega
o Plotly, cuentas y equipos de W&B (randl tiene un único propietario), referencias
externas de artefactos ni cargas de artefactos en varias partes, ni llamadas a la API
pública más allá de la lectura de ejecuciones. Las solicitudes no admitidas devuelven
errores en lugar de fingir que almacenan datos.

## Autoalojamiento

En su propia estación de trabajo, basta con `npm start`. Para usar randl desde otros
equipos, asígnele una clave de API de propietario y colóquelo detrás de un proxy inverso
HTTPS:

```sh
export RANDL_API_KEY="$(openssl rand -hex 32)"
export RANDL_PUBLIC_URL=https://randl.example.com
npm start -- --host 127.0.0.1 --data-dir /srv/randl
```

El navegador inicia sesión con la clave. En los equipos cliente, exporte la misma clave
como `RANDL_API_KEY`; la CLI lee `RANDL_URL` y `RANDL_API_KEY`, y el SDK recibe los
mismos valores:

```sh
export RANDL_URL=https://randl.example.com
export WANDB_BASE_URL="$RANDL_URL"
export WANDB_API_KEY="$RANDL_API_KEY"
```

[DEPLOYMENT.md](DEPLOYMENT.md) (en inglés) cubre el ejemplo de Caddy de
[deploy/Caddyfile](deploy/Caddyfile), las copias de seguridad, los límites de carga y la
configuración del proveedor del Asistente.

| Opción de `randl serve` | Valor predeterminado | Propósito                                                                              |
| ----------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| `--port`                | `8742`               | Puerto de escucha                                                                      |
| `--host`                | `127.0.0.1`          | Dirección de escucha                                                                   |
| `--data-dir`            | `.data`              | Base de datos, archivos subidos y plugins instalados                                   |
| `--public-url`          |                      | Dirección HTTPS pública (o `RANDL_PUBLIC_URL`)                                         |
| `--entity`              | `local`              | Entidad para las ejecuciones que no indican ninguna (o `RANDL_ENTITY`)                 |
| `--run-timeout`         | `600`                | Segundos sin contacto del SDK antes de marcar una ejecución en curso como interrumpida |
| `--frontend-dir`        | `frontend/dist`      | Sirve una copia desplegada de la interfaz compilada                                    |
| `--pi-agent-dir`        | `<data-dir>/pi`      | Directorio del perfil del Asistente (o `RANDL_PI_AGENT_DIR`)                           |

Si `ffmpeg` está instalado, randl lo usa para crear las portadas de los videos; defina
`RANDL_FFMPEG` con su ruta, o con `off`.

## Línea de comandos

Los ejemplos usan el alias `randl` del recorrido; en scripts, llame en su lugar a
`node /path/to/randl/backend/dist/cli.js`. Cada comando imprime JSON, termina con un
código de salida distinto de cero si hay errores y se conecta a `RANDL_URL` (de forma
predeterminada `http://127.0.0.1:8742`) con `RANDL_API_KEY` cuando el servidor tiene una
clave. `randl --help` los enumera todos.

```sh
randl status
randl projects list
randl projects create --id local/robotics --name Robotics
randl runs --project local/quickstart
randl runs show --id local/quickstart/RUN_ID
randl runs add-tags --ids local/quickstart/RUN_ID --tags baseline
randl views list
randl artifacts list
randl artifacts download --id ARTIFACT_ID --output ./downloads
randl projects delete --id local/robotics --confirm Robotics
```

## Plugins de paneles

Todos los paneles, integrados o instalados, usan la misma interfaz de plugins: un
manifiesto `panel.json` y un módulo de navegador que recibe los datos y los representa.
Los plugins pueden agregar opciones con tipo al editor de paneles e incluir sus propias
traducciones. Instale uno desde un directorio local o un repositorio de GitHub:

```sh
randl plugins install --source ./examples/plugins/stat-card
randl plugins enable --id stat-card
```

Los plugins instalados empiezan desactivados. Una vez activados, se ejecutan en el tablero
con acceso a sus datos, así que instale solo código de confianza. randl copia el origen y
nunca ejecuta scripts de instalación ni de compilación. Consulte [PLUGINS.md](PLUGINS.md)
(en inglés) para escribir los suyos.

## Estado

randl es joven y cambia rápidamente; espere cambios incompatibles entre versiones. Es una
implementación independiente, no está afiliada a Weights & Biases; el servidor y el
tablero de W&B no forman parte de ella. [CONTRIBUTING.md](CONTRIBUTING.md) (en inglés) describe
la configuración de desarrollo, las pruebas y la arquitectura.

## Licencia

randl se publica bajo la [licencia MIT](LICENSE).
