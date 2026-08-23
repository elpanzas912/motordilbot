const fs = require("node:fs");
const path = require("node:path");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith("#")) continue;

    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

loadDotEnv(path.join(__dirname, ".env"));

const API_URL = process.env.MOTORDIL_API_URL || "https://prod-api.motordil.com/graphql";
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "motordil_state.json");
const PAGE_LIMIT = Math.min(Math.max(Number(process.env.MOTORDIL_PAGE_LIMIT || 500), 1), 500);
const TELEGRAM_DELAY_MS = Math.max(Number(process.env.TELEGRAM_DELAY_MS || 1200), 0);
const SEND_EXISTING_ON_FIRST_RUN = process.env.SEND_EXISTING_ON_FIRST_RUN === "true";
const DRY_RUN = process.argv.includes("--dry-run");

const LISTINGS_QUERY = `
  query Listings($request: ListingsRequest!) {
    listings(request: $request) {
      listings {
        id
        slug
        status
        price
        year
        odometer
        publishedAt
        currency { symbol }
        media { mediaType uri }
        metadata {
          make { make normalized }
          model
          version
          vehicleType
        }
        details { transmissionType fuelType }
      }
    }
  }
`;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}.`);
  return value;
}

async function postJson(url, body, headers = {}) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });

      const json = await response.json();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (json.errors?.length) {
        throw new Error(json.errors.map(error => error.message).join("; "));
      }
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 1500);
    }
  }

  throw lastError;
}

async function fetchListings() {
  const response = await postJson(
    API_URL,
    {
      query: LISTINGS_QUERY,
      variables: {
        request: {
          filters: { vehicleType: "CAR" },
          page: 1,
          limit: PAGE_LIMIT
        }
      }
    },
    {
      Origin: "https://www.motordil.com",
      Referer: "https://www.motordil.com/autos",
      "User-Agent": "MotordilTelegramBot/1.0"
    }
  );

  const listings = response.data?.listings?.listings;
  if (!Array.isArray(listings)) throw new Error("La respuesta de Motordil no contiene publicaciones.");
  return listings.map(normalizeListing).filter(listing => listing.id);
}

function normalizeListing(listing) {
  const metadata = listing.metadata || {};
  const make = metadata.make?.make || "";
  const title = [listing.year, make, metadata.model, metadata.version]
    .filter(value => value !== null && value !== undefined && String(value).trim())
    .join(" ");
  const price = listing.price === null || listing.price === undefined
    ? "No informado"
    : `${listing.currency?.symbol || ""} ${new Intl.NumberFormat("es-AR").format(listing.price)}`.trim();

  return {
    id: String(listing.id),
    slug: listing.slug || String(listing.id),
    title: title || "Vehículo publicado",
    price,
    year: listing.year,
    kilometers: listing.odometer,
    status: listing.status,
    transmission: listing.details?.transmissionType,
    fuel: listing.details?.fuelType,
    image: listing.media?.find(media => media.mediaType === "PHOTO")?.uri || "",
    url: `https://www.motordil.com/auto/${encodeURIComponent(listing.slug || listing.id)}`
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { initialized: false, knownIds: [], confirmationSent: false };

  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      initialized: Boolean(state.initialized),
      knownIds: Array.isArray(state.knownIds) ? state.knownIds.map(String) : [],
      confirmationSent: Boolean(state.confirmationSent)
    };
  } catch (error) {
    throw new Error(`No se pudo leer ${STATE_FILE}: ${error.message}`);
  }
}

function saveState(state) {
  const directory = path.dirname(STATE_FILE);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function mergeKnownIds(state, listings) {
  const ids = new Set([...state.knownIds, ...listings.map(listing => listing.id)]);
  state.knownIds = [...ids].slice(-2000);
  state.initialized = true;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatListing(listing) {
  const details = [
    listing.year && `Año: ${listing.year}`,
    listing.kilometers !== null && listing.kilometers !== undefined && `KM: ${new Intl.NumberFormat("es-AR").format(listing.kilometers)}`,
    listing.transmission && `Caja: ${listing.transmission}`,
    listing.fuel && `Combustible: ${listing.fuel}`
  ].filter(Boolean);

  return [
    "<b>Nueva publicación en Motordil</b>",
    "",
    `<b>${escapeHtml(listing.title)}</b>`,
    `<b>Precio:</b> ${escapeHtml(listing.price)}`,
    details.map(detail => escapeHtml(detail)).join(" | "),
    "",
    `<a href="${escapeHtml(listing.url)}">Ver publicación</a>`
  ].filter(Boolean).join("\n");
}

async function telegramRequest(method, body, token) {
  const response = await postJson(`https://api.telegram.org/bot${token}/${method}`, body);
  if (!response.ok) throw new Error(response.description || `Telegram rechazó ${method}.`);
  return response.result;
}

async function sendListing(listing, token, chatId) {
  const text = formatListing(listing);

  if (listing.image) {
    try {
      await telegramRequest("sendPhoto", {
        chat_id: chatId,
        photo: listing.image,
        caption: text,
        parse_mode: "HTML"
      }, token);
      return;
    } catch (error) {
      console.warn(`No se pudo enviar la foto de ${listing.id}; se enviará solo texto: ${error.message}`);
    }
  }

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false
  }, token);
}

async function sendActivationConfirmation(state, token, chatId) {
  if (state.confirmationSent) return;

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "<b>Motordil Avisos está activo</b>\n\nLa revisión automática de nuevas publicaciones quedó configurada cada 5 minutos.",
    parse_mode: "HTML"
  }, token);

  state.confirmationSent = true;
  saveState(state);
  console.log("Confirmación de activación enviada.");
}

async function printChatIds(token) {
  const updates = await telegramRequest("getUpdates", { limit: 100 }, token);
  const chats = new Map();
  for (const update of updates) {
    const chat = update.message?.chat || update.channel_post?.chat;
    if (chat) chats.set(String(chat.id), `${chat.type} ${chat.title || chat.username || chat.first_name || ""}`.trim());
  }

  if (!chats.size) {
    console.log("No hay mensajes recientes. Enviá /start al bot y ejecutá el comando nuevamente.");
    return;
  }

  for (const [id, name] of chats) console.log(`${id}\t${name}`);
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (process.argv.includes("--chat-id")) {
    if (!token) throw new Error("Definí TELEGRAM_BOT_TOKEN para consultar los chats.");
    await printChatIds(token);
    return;
  }

  if (!DRY_RUN) {
    requiredEnv("TELEGRAM_BOT_TOKEN");
    requiredEnv("TELEGRAM_CHAT_ID");
  }

  const listings = await fetchListings();
  const state = loadState();
  const knownIds = new Set(state.knownIds);
  const isFirstRun = !state.initialized;
  const newListings = listings.filter(listing => !knownIds.has(listing.id)).reverse();

  console.log(`Publicaciones consultadas: ${listings.length}. Nuevas: ${newListings.length}.`);

  if (isFirstRun && !SEND_EXISTING_ON_FIRST_RUN) {
    mergeKnownIds(state, listings);
    if (!DRY_RUN) {
      saveState(state);
      await sendActivationConfirmation(state, token, process.env.TELEGRAM_CHAT_ID);
    }
    console.log("Primera ejecución: se guardó el estado sin enviar el lote existente.");
    return;
  }

  if (DRY_RUN) {
    for (const listing of newListings) console.log(`${listing.id} | ${listing.title} | ${listing.url}`);
    return;
  }

  for (const listing of newListings) {
    await sendListing(listing, token, process.env.TELEGRAM_CHAT_ID);
    knownIds.add(listing.id);
    state.knownIds = [...knownIds].slice(-2000);
    state.initialized = true;
    saveState(state);
    console.log(`Aviso enviado: ${listing.title}`);
    await sleep(TELEGRAM_DELAY_MS);
  }

  mergeKnownIds(state, listings);
  saveState(state);
  await sendActivationConfirmation(state, token, process.env.TELEGRAM_CHAT_ID);
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
