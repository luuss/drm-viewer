"""
Fake Shop for testing DRM Reader
Run alongside main.py on a different port
"""
import time
import hmac
import hashlib
import httpx
from fastapi import FastAPI, Form
from fastapi.responses import HTMLResponse, RedirectResponse

app = FastAPI()

READER_URL = "http://localhost:8000"
SHARED_SECRET = "prestashop-shared-secret-change-me"

# Fake products (product_id must match filename without .pdf)
PRODUCTS = [
    {"id": "312n Innenteil Bologna", "title": "Bologna", "price": "12.99€"},
    {"id": "27306_9783313000011_v-2", "title": "ePub Testbuch", "price": "9.99€"},
    {"id": "Bitcoin_Whitepaper", "title": "Bitcoin Whitepaper", "price": "0.00€"},
    {"id": "US_Constitution", "title": "US Constitution", "price": "0.00€"},
    {"id": "Linux_Basics", "title": "Linux Basics Guide", "price": "4.99€"},
    {"id": "Git_Cheatsheet", "title": "Git Cheatsheet", "price": "1.99€"},
]

def generate_signed_url(email: str, name: str, open_product: str | None = None) -> str:
    ts = str(int(time.time()))
    message = f"{email}:{name}:{ts}"
    sig = hmac.new(SHARED_SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()
    url = f"{READER_URL}/auth?email={email}&name={name}&ts={ts}&sig={sig}"
    if open_product:
        url += f"&open_product={open_product}"
    return url


@app.get("/", response_class=HTMLResponse)
async def shop_home():
    products_html = ""
    for p in PRODUCTS:
        products_html += f'''
        <div class="product">
            <h3>{p["title"]}</h3>
            <p class="price">{p["price"]}</p>
            <form method="post" action="/buy">
                <input type="hidden" name="product_id" value="{p["id"]}">
                <input type="hidden" name="title" value="{p["title"]}">
                <button type="submit">🛒 Kaufen</button>
            </form>
        </div>
        '''

    return f'''
    <!DOCTYPE html>
    <html>
    <head>
        <title>Fake Book Shop</title>
        <style>
            * {{ margin: 0; padding: 0; box-sizing: border-box; }}
            body {{
                font-family: system-ui, sans-serif;
                background: #1a1a2e;
                color: #eee;
                min-height: 100vh;
                padding: 40px;
            }}
            h1 {{ text-align: center; margin-bottom: 40px; color: #fff; }}
            .products {{
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
                gap: 20px;
                max-width: 800px;
                margin: 0 auto 40px;
            }}
            .product {{
                background: #16213e;
                border-radius: 12px;
                padding: 24px;
                text-align: center;
            }}
            .product h3 {{ margin-bottom: 12px; }}
            .price {{ color: #4ade80; font-size: 1.5em; margin-bottom: 16px; }}
            button {{
                background: #4ade80;
                color: #000;
                border: none;
                padding: 12px 24px;
                border-radius: 8px;
                font-size: 1em;
                cursor: pointer;
                font-weight: bold;
            }}
            button:hover {{ background: #22c55e; }}
            .account {{
                max-width: 800px;
                margin: 0 auto;
                background: #16213e;
                border-radius: 12px;
                padding: 24px;
                text-align: center;
            }}
            .account h2 {{ margin-bottom: 20px; }}
            .account a {{
                display: inline-block;
                background: #3b82f6;
                color: #fff;
                padding: 12px 24px;
                border-radius: 8px;
                text-decoration: none;
                font-weight: bold;
            }}
            .account a:hover {{ background: #2563eb; }}
            .info {{
                max-width: 800px;
                margin: 20px auto;
                padding: 16px;
                background: #0f3460;
                border-radius: 8px;
                font-size: 0.9em;
            }}
        </style>
    </head>
    <body>
        <h1>📚 Fake Book Shop</h1>

        <div class="info">
            <strong>Test User:</strong> test@example.com (Max Mustermann)
        </div>

        <div class="products">
            {products_html}
        </div>

        <div class="account">
            <h2>Mein Konto</h2>
            <a href="/my-ebooks">📖 Meine eBooks öffnen</a>
        </div>
    </body>
    </html>
    '''


@app.post("/buy")
async def buy_product(product_id: str = Form(...), title: str = Form(...)):
    # Simulate purchase - send webhook to DRM reader
    email = "test@example.com"
    name = "Max Mustermann"

    webhook_data = {
        "secret": SHARED_SECRET,
        "email": email,
        "product_id": product_id,
        "name": name
    }

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(f"{READER_URL}/api/webhook/prestashop", json=webhook_data)
            resp.raise_for_status()
    except Exception as e:
        return HTMLResponse(f'''
            <html><body style="background:#1a1a2e;color:#fff;padding:40px;font-family:sans-serif;">
            <h1>❌ Fehler</h1>
            <p>DRM Reader nicht erreichbar: {e}</p>
            <p>Stelle sicher, dass der Reader auf {READER_URL} läuft.</p>
            <a href="/" style="color:#4ade80;">← Zurück</a>
            </body></html>
        ''')

    return HTMLResponse(f'''
        <html><body style="background:#1a1a2e;color:#fff;padding:40px;font-family:sans-serif;text-align:center;">
        <h1>✅ Kauf erfolgreich!</h1>
        <p style="font-size:1.2em;margin:20px 0;">"{title}" wurde freigeschaltet.</p>
        <a href="/my-ebooks?product_id={product_id}" style="display:inline-block;background:#4ade80;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">📖 Jetzt lesen</a>
        <br><br>
        <a href="/" style="color:#888;">← Weiter einkaufen</a>
        </body></html>
    ''')


@app.get("/my-ebooks")
async def my_ebooks(product_id: str | None = None):
    # Generate signed URL and redirect to reader
    email = "test@example.com"
    name = "Max Mustermann"
    signed_url = generate_signed_url(email, name, open_product=product_id)
    return RedirectResponse(signed_url)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
