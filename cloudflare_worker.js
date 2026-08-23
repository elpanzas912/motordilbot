const API_URL = "https://prod-api.motordil.com/graphql";
const STATE_KEY = "motordil-state";
const PAGE_LIMIT = 500;
const TELEGRAM_DELAY_MS = 1200;

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

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Falta configurar ${name} en Cloudflare.`);
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
      "User-Agent": "MotordilCloudflareWorker/1.0"
    }
  );

  const listings = response.data?.listings?.listings;
  if (!Array.isArray(listings)) throw new Error("Motordil no devolvió publicaciones.");
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
    transmission: listing.details?.transmissionType,
    fuel: listing.details?.fuelType,
    image: listing.media?.find(media => media.mediaType === "PHOTO")?.uri || "",
    url: `https://www.motordil.com/auto/${encodeURIComponent(listing.slug || listing.id)}`
  };
}

async function loadState(env) {
  const raw = await env.MOTORDIL_STATE.get(STATE_KEY);
  if (!raw) return { initialized: false, knownIds: [], confirmationSent: false };

  try {
    const state = JSON.parse(raw);
    return {
      initialized: Boolean(state.initialized),
      knownIds: Array.isArray(state.knownIds) ? state.knownIds.map(String) : [],
      confirmationSent: Boolean(state.confirmationSent)
    };
  } catch (error) {
    throw new Error(`El estado de KV no es válido: ${error.message}`);
  }
}

async function saveState(env, state) {
  await env.MOTORDIL_STATE.put(STATE_KEY, JSON.stringify(state));
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

async function sendActivationConfirmation(env, state, token, chatId) {
  if (state.confirmationSent) return;

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "<b>Motordil Avisos está activo</b>\n\nLa revisión automática de nuevas publicaciones quedó configurada cada 5 minutos.",
    parse_mode: "HTML"
  }, token);

  state.confirmationSent = true;
  await saveState(env, state);
}

async function run(env) {
  const token = requiredEnv(env, "TELEGRAM_BOT_TOKEN");
  const chatId = requiredEnv(env, "TELEGRAM_CHAT_ID");
  const listings = await fetchListings();
  const state = await loadState(env);
  const knownIds = new Set(state.knownIds);
  const isFirstRun = !state.initialized;
  const newListings = listings.filter(listing => !knownIds.has(listing.id)).reverse();

  if (isFirstRun && env.SEND_EXISTING_ON_FIRST_RUN !== "true") {
    mergeKnownIds(state, listings);
    await saveState(env, state);
    await sendActivationConfirmation(env, state, token, chatId);
    return { checked: listings.length, sent: 0, seeded: true };
  }

  for (const listing of newListings) {
    await sendListing(listing, token, chatId);
    knownIds.add(listing.id);
    state.knownIds = [...knownIds].slice(-2000);
    state.initialized = true;
    await saveState(env, state);
    await sleep(TELEGRAM_DELAY_MS);
  }

  mergeKnownIds(state, listings);
  await saveState(env, state);
  await sendActivationConfirmation(env, state, token, chatId);

  return { checked: listings.length, sent: newListings.length, seeded: false };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export default {
  async scheduled(controller, env) {
    await run(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "motordil-telegram-bot" });
    }

    if (url.pathname === "/run") {
      const expected = env.MANUAL_RUN_SECRET;
      const provided = request.headers.get("Authorization");
      if (!expected || provided !== `Bearer ${expected}`) {
        return jsonResponse({ ok: false, error: "No autorizado." }, 401);
      }

      try {
        return jsonResponse({ ok: true, ...(await run(env)) });
      } catch (error) {
        console.error(error);
        return jsonResponse({ ok: false, error: error.message }, 500);
      }
    }

    return new Response("Motordil Telegram Worker", { status: 404 });
  }
};
