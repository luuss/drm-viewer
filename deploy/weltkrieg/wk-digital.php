<?php
/**
 * Plugin Name: WK — Digital-Leser
 * Description: Verbindung zwischen WooCommerce (weltkrieg-online.de) und dem Leser digital.weltkrieg-online.de.
 *              Gegenstueck zum PrestaShop-Modul lusdigital (lesenundschenken.de): gleicher Vertrag, gleiche
 *              Signatur. E-Books gibt es nur noch zum Lesen im Leser; gekauft wird hier an der Kasse.
 *              Quelle: drm-viewer/deploy/weltkrieg/wk-digital.php, Doku drm-viewer/docs/weltkrieg-digital.md.
 * Version: 2.0
 * Author: WK
 *
 * 1. Schnittstelle fuer den Leser
 *    POST https://weltkrieg-online.de/wp-json/wkdigital/v1/api
 *    Rumpf:  JSON mit "action" und "ts" (Unix-Sekunden).
 *    Header: x-shop-signature = hex(HMAC-SHA256(roher Rumpf, Geheimnis)).
 *    Geheimnis: Option "wkdigital_secret" (gleich SHOP_WEBHOOK_SECRET im Leser).
 *    Aktionen: send_mail, heft_mail, search, product, offer_digital, withdraw_digital.
 *    quote, create_order, refund_order: 501 (kein Kartenkauf im Leser, bezahlt wird hier).
 *
 * 2. Warenkorb aus dem Leser
 *    GET https://weltkrieg-online.de/?wkdigital-warenkorb=1&artikel=SKU1,SKU2&email=kunde@example.de
 *    legt die E-Books in den Warenkorb, belegt die E-Mail vor und springt in die Kasse.
 *
 * 3. Freischaltung im Leser
 *    Bestellung "in Bearbeitung"/"abgeschlossen" -> grant, "erstattet"/"storniert" und voll erstattete
 *    Positionen -> revoke, an https://digital.weltkrieg-online.de/hooks/shop/entitlements (Vertrag v2).
 *    Fehlgeschlagene Meldungen wiederholt WP-Cron. Jede Meldung steht als Notiz an der Bestellung.
 *
 * Das E-Book eines Hefts ist die Variante "E-Book" des Attributs "Ebook, Heft" (wie bei den bestehenden
 * Produkten), virtuell und herunterladbar (dann fragt Germanized den Verzicht auf das Widerrufsrecht bei
 * digitalen Inhalten ab), hoechstens einmal je Bestellung. Ihre SKU ist die Artikelnummer im Leser, dazu
 * die Markierung _wkdigital_sku.
 */

defined( 'ABSPATH' ) || exit;

const WKDIGITAL_ZEITFENSTER    = 300;
const WKDIGITAL_LESER          = 'https://digital.weltkrieg-online.de';
const WKDIGITAL_LINK_PRAEFIX   = 'https://digital.weltkrieg-online.de/';
const WKDIGITAL_MAX_PRO_STUNDE = 5;
const WKDIGITAL_HEFTMAIL_MAX   = 20;
const WKDIGITAL_GUELTIG_MIN    = 15;
const WKDIGITAL_ABSENDER       = 'versand@weltkrieg-online.de';
const WKDIGITAL_ABSENDER_NAME  = 'Weltkrieg Digital';
const WKDIGITAL_ATTR           = 'ebook-heft';
const WKDIGITAL_ATTR_NAME      = 'Ebook, Heft';
const WKDIGITAL_EBOOK          = 'E-Book';
const WKDIGITAL_HEFT           = 'Heft';
const WKDIGITAL_META_SKU       = '_wkdigital_sku';
const WKDIGITAL_SKU_MUSTER     = '/^[A-Za-z0-9._-]{1,64}$/';
const WKDIGITAL_NACHSENDEN     = 'wkdigital_nachsenden';
const WKDIGITAL_MAX_VERSUCHE   = 20;

add_action( 'rest_api_init', function () {
	register_rest_route( 'wkdigital/v1', '/api', array(
		'methods'             => 'POST',
		'callback'            => 'wkdigital_api',
		'permission_callback' => '__return_true', // Pruefung per Signatur in wkdigital_api()
	) );
} );

function wkdigital_antwort( $status, array $daten ) {
	$r = new WP_REST_Response( $daten, $status );
	$r->header( 'Cache-Control', 'no-store' );
	return $r;
}

function wkdigital_fehler( $status, $kennung, $text ) {
	return wkdigital_antwort( $status, array( 'ok' => false, 'error' => $kennung, 'message' => $text ) );
}

function wkdigital_geheimnis() {
	return (string) get_option( 'wkdigital_secret', '' );
}

function wkdigital_api( WP_REST_Request $request ) {
	$geheimnis = wkdigital_geheimnis();
	if ( '' === $geheimnis ) {
		return wkdigital_fehler( 403, 'not_configured', 'Die Schnittstelle ist nicht eingerichtet (Geheimnis fehlt).' );
	}
	$roh = (string) $request->get_body();
	$sig = strtolower( trim( (string) $request->get_header( 'x-shop-signature' ) ) );
	if ( '' === $sig || ! hash_equals( hash_hmac( 'sha256', $roh, $geheimnis ), $sig ) ) {
		return wkdigital_fehler( 403, 'bad_signature', 'Signatur fehlt oder ist falsch.' );
	}
	$d = json_decode( $roh, true );
	if ( ! is_array( $d ) ) {
		return wkdigital_fehler( 400, 'bad_json', 'Der Rumpf ist kein gültiges JSON-Objekt.' );
	}
	$ts = isset( $d['ts'] ) && is_numeric( $d['ts'] ) ? (int) $d['ts'] : 0;
	if ( ! $ts || abs( time() - $ts ) > WKDIGITAL_ZEITFENSTER ) {
		return wkdigital_fehler( 403, 'bad_timestamp', 'Zeitstempel fehlt oder weicht mehr als 300 Sekunden ab.' );
	}

	$aktion = (string) ( $d['action'] ?? '' );
	if ( in_array( $aktion, array( 'search', 'product', 'offer_digital', 'withdraw_digital' ), true ) && ! function_exists( 'wc_get_product' ) ) {
		return wkdigital_fehler( 503, 'no_shop', 'WooCommerce ist nicht geladen.' );
	}
	switch ( $aktion ) {
		case 'send_mail':
			return wkdigital_anmeldelink( $d );
		case 'heft_mail':
			return wkdigital_heftmail( $d );
		case 'search':
			return wkdigital_suche( $d );
		case 'product':
			return wkdigital_produkt_holen( $d );
		case 'offer_digital':
			return wkdigital_anbieten( $d );
		case 'withdraw_digital':
			return wkdigital_zuruecknehmen( $d );
		case 'quote':
		case 'create_order':
		case 'refund_order':
			return wkdigital_fehler( 501, 'not_implemented', 'Bezahlt wird an der Kasse von weltkrieg-online.de, nicht im Leser.' );
		default:
			return wkdigital_fehler( 400, 'unknown_action', 'Unbekannte Aktion.' );
	}
}

/* ------------------------------------------------------------------------------------------------
 * Mails
 * --------------------------------------------------------------------------------------------- */

/** Zaehlt Mails je Empfaenger und Stunde (Transient, Empfaenger nur als SHA-256). Wahr = noch erlaubt. */
function wkdigital_mail_zaehlen( $art, $an, $max ) {
	$schluessel = 'wkdigital_' . $art . '_' . substr( hash( 'sha256', $an ), 0, 40 );
	$jetzt      = time();
	$zeiten     = array_filter( (array) get_transient( $schluessel ), function ( $t ) use ( $jetzt ) {
		return is_int( $t ) && $t > $jetzt - HOUR_IN_SECONDS;
	} );
	if ( count( $zeiten ) >= $max ) {
		return false;
	}
	// Vor dem Senden zaehlen: auch ein fehlgeschlagener Versuch zaehlt.
	$zeiten[] = $jetzt;
	set_transient( $schluessel, array_values( $zeiten ), HOUR_IN_SECONDS );
	return true;
}

function wkdigital_link_ok( $link ) {
	return 0 === strpos( $link, WKDIGITAL_LINK_PRAEFIX )
		&& strlen( $link ) <= 1000
		&& ! preg_match( '/[\s<>"\'\\\\\x00-\x1f\x7f]/', $link )
		&& filter_var( $link, FILTER_VALIDATE_URL );
}

/** Mail mit Envelope-From (SPF) und Textfassung versenden. */
function wkdigital_mail( $an, $betreff, $html, $text, $absender_name, array $zusatz = array() ) {
	$absender = function ( $phpmailer ) use ( $text ) {
		$phpmailer->Sender  = WKDIGITAL_ABSENDER; // Envelope-From, damit SPF (a) greift
		$phpmailer->AltBody = '' !== $text ? $text : wp_strip_all_tags( str_replace( array( '<br>', '</p>' ), "\n", $phpmailer->Body ) );
	};
	add_action( 'phpmailer_init', $absender );
	$ok = wp_mail(
		$an,
		$betreff,
		$html,
		array_merge(
			array(
				'Content-Type: text/html; charset=UTF-8',
				'From: ' . $absender_name . ' <' . WKDIGITAL_ABSENDER . '>',
			),
			$zusatz
		)
	);
	remove_action( 'phpmailer_init', $absender );
	return $ok;
}

/**
 * Anmeldelink verschicken. Eng begrenzt, damit die Schnittstelle kein allgemeiner Mailversand wird:
 * nur Vorlage "lusdigital_login" (Name kommt so aus dem Leser), nur Links auf digital.weltkrieg-online.de,
 * hoechstens 5 Mails je Empfaenger und Stunde.
 */
function wkdigital_anmeldelink( array $d ) {
	if ( 'lusdigital_login' !== (string) ( $d['template'] ?? '' ) ) {
		return wkdigital_fehler( 400, 'bad_template', 'Unbekannte Mailvorlage.' );
	}
	$an = strtolower( trim( (string) ( $d['to'] ?? '' ) ) );
	if ( '' === $an || strlen( $an ) > 254 || ! is_email( $an ) ) {
		return wkdigital_fehler( 400, 'bad_email', 'Empfängeradresse ungültig.' );
	}
	$link = (string) ( $d['link'] ?? '' );
	if ( ! wkdigital_link_ok( $link ) ) {
		return wkdigital_fehler( 400, 'bad_link', 'Der Link muss auf ' . WKDIGITAL_LINK_PRAEFIX . ' zeigen.' );
	}
	if ( ! wkdigital_mail_zaehlen( 'mail', $an, WKDIGITAL_MAX_PRO_STUNDE ) ) {
		return wkdigital_fehler( 429, 'rate_limited', 'Zu viele Mails an diese Adresse in der letzten Stunde.' );
	}

	$l    = esc_url( $link );
	$html = '<!doctype html><html lang="de"><body style="margin:0;background:#f2efe8;font-family:Georgia,serif;color:#222">'
		. '<div style="max-width:540px;margin:0 auto;padding:28px 24px;background:#fff">'
		. '<p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#7a6a4f;margin:0 0 18px">Weltkrieg Digital</p>'
		. '<h1 style="font-size:22px;margin:0 0 16px">Ihr Anmeldelink</h1>'
		. '<p style="font-size:16px;line-height:1.5">Guten Tag,<br>mit diesem Knopf melden Sie sich im Leser von weltkrieg-online.de an:</p>'
		. '<p style="margin:24px 0"><a href="' . $l . '" style="display:inline-block;background:#3d3a2e;color:#fff;text-decoration:none;padding:12px 22px;font-size:16px;font-family:Arial,sans-serif">Jetzt anmelden</a></p>'
		. '<p style="font-size:14px;line-height:1.5;color:#555">Der Link gilt ' . WKDIGITAL_GUELTIG_MIN . ' Minuten und nur einmal. Er meldet den Browser an, in dem Sie ihn öffnen.</p>'
		. '<p style="font-size:13px;line-height:1.5;color:#777;word-break:break-all">Falls der Knopf nicht geht: ' . esc_html( $link ) . '</p>'
		. '<p style="font-size:14px;line-height:1.5;color:#555">Sie haben keinen Link angefordert? Dann ignorieren Sie diese E-Mail einfach. Ohne Klick passiert nichts.</p>'
		. '<p style="font-size:13px;color:#777;margin-top:28px">weltkrieg-online.de · Histomedia AG</p>'
		. '</div></body></html>';

	if ( ! wkdigital_mail( $an, 'Ihr Anmeldelink für Weltkrieg Digital', $html, '', WKDIGITAL_ABSENDER_NAME ) ) {
		error_log( 'wk-digital send_mail: wp_mail fehlgeschlagen' );
		return wkdigital_fehler( 502, 'mail_failed', 'Der Shop konnte die Mail nicht versenden.' );
	}
	return wkdigital_antwort( 200, array( 'ok' => true ) );
}

/**
 * Mail zu einem neuen Heft an einen Kaeufer (convex/heftAnkuendigung.ts). Inhalt und Abmeldelink kommen
 * fertig aus dem Leser; hier wird nur geprueft und versandt, mit Abmeldung in einem Klick (RFC 8058).
 */
function wkdigital_heftmail( array $d ) {
	$an = strtolower( trim( (string) ( $d['to'] ?? '' ) ) );
	if ( '' === $an || strlen( $an ) > 254 || ! is_email( $an ) ) {
		return wkdigital_fehler( 400, 'bad_email', 'Empfängeradresse ungültig.' );
	}
	$betreff = trim( (string) ( $d['subject'] ?? '' ) );
	if ( '' === $betreff || strlen( $betreff ) > 300 || preg_match( '/[\r\n]/', $betreff ) ) {
		return wkdigital_fehler( 400, 'bad_subject', 'Betreff fehlt oder ist ungültig.' );
	}
	$html = (string) ( $d['html'] ?? '' );
	$text = (string) ( $d['text'] ?? '' );
	if ( '' === $html || strlen( $html ) > 500000 || strlen( $text ) > 200000 ) {
		return wkdigital_fehler( 400, 'bad_content', 'Inhalt fehlt oder ist zu lang.' );
	}
	$name = trim( (string) ( $d['from_name'] ?? WKDIGITAL_ABSENDER_NAME ) );
	if ( '' === $name || strlen( $name ) > 120 || preg_match( '/[\r\n<>"]/', $name ) ) {
		$name = WKDIGITAL_ABSENDER_NAME;
	}
	$abmelden = (string) ( $d['unsubscribe'] ?? '' );
	if ( ! wkdigital_link_ok( $abmelden ) ) {
		return wkdigital_fehler( 400, 'bad_link', 'Der Abmeldelink muss auf ' . WKDIGITAL_LINK_PRAEFIX . ' zeigen.' );
	}
	if ( ! wkdigital_mail_zaehlen( 'heft', $an, WKDIGITAL_HEFTMAIL_MAX ) ) {
		return wkdigital_fehler( 429, 'rate_limited', 'Zu viele Mails an diese Adresse in der letzten Stunde.' );
	}
	$ok = wkdigital_mail( $an, $betreff, $html, $text, $name, array(
		'List-Unsubscribe: <' . $abmelden . '>',
		'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
	) );
	if ( ! $ok ) {
		error_log( 'wk-digital heft_mail: wp_mail fehlgeschlagen' );
		return wkdigital_fehler( 502, 'mail_failed', 'Der Shop konnte die Mail nicht versenden.' );
	}
	return wkdigital_antwort( 200, array( 'ok' => true ) );
}

/* ------------------------------------------------------------------------------------------------
 * Produkte
 * --------------------------------------------------------------------------------------------- */

/** Variante eines variablen Produkts mit diesem Wert von "Ebook, Heft", oder null. */
function wkdigital_variante( WC_Product $p, $wert ) {
	if ( ! $p->is_type( 'variable' ) ) {
		return null;
	}
	foreach ( $p->get_children() as $vid ) {
		$v = wc_get_product( $vid );
		if ( $v && $wert === $v->get_attribute( WKDIGITAL_ATTR ) ) {
			return $v;
		}
	}
	return null;
}

function wkdigital_euro( $preis ) {
	return '' === (string) $preis ? null : round( (float) $preis, 2 );
}

/** Produktformat des Vertrags (docs/shop-integration.md, "Produktformat"). */
function wkdigital_produkt( WC_Product $p ) {
	if ( $p->is_type( 'variation' ) ) {
		$p = wc_get_product( $p->get_parent_id() );
	}
	$druck = wkdigital_variante( $p, WKDIGITAL_HEFT ) ?: $p;
	$ebook = wkdigital_variante( $p, WKDIGITAL_EBOOK );
	$bild  = $p->get_image_id() ? wp_get_attachment_image_url( $p->get_image_id(), 'large' ) : false;
	$kat   = wp_get_post_terms( $p->get_id(), 'product_cat', array( 'fields' => 'names' ) );
	$aktiv = 'publish' === $p->get_status();
	// Nur eine E-Book-Variante, die der Leser angelegt oder uebernommen hat (offer_digital), ist
	// fuer ihn kaufbar: nur sie legt der Warenkorb-Link ab und nur sie schaltet frei. Die alten
	// Varianten mit EPUB zum Herunterladen meldet die Schnittstelle als nicht angeboten.
	$unsere = $ebook && '' !== (string) $ebook->get_meta( WKDIGITAL_META_SKU );
	return array(
		'id'           => $p->get_id(),
		'name'         => html_entity_decode( wp_strip_all_tags( $p->get_name() ), ENT_QUOTES, 'UTF-8' ),
		'reference'    => (string) $p->get_sku(),
		'price_gross'  => wkdigital_euro( $druck->get_price() ),
		'url'          => get_permalink( $p->get_id() ),
		'cover_url'    => $bild ? $bild : null,
		'manufacturer' => is_array( $kat ) ? html_entity_decode( implode( ', ', $kat ), ENT_QUOTES, 'UTF-8' ) : '',
		'active'       => $aktiv && $druck->is_purchasable(),
		'digital'      => $ebook ? array(
			'id_product_attribute' => $ebook->get_id(),
			'sku'                  => (string) $ebook->get_sku(),
			'price_gross'          => wkdigital_euro( $ebook->get_price() ),
			'available'            => $unsere && $aktiv && 'publish' === $ebook->get_status() && '' !== (string) $ebook->get_price(),
		) : null,
	);
}

function wkdigital_produkt_holen( array $d ) {
	$id = isset( $d['id'] ) && is_numeric( $d['id'] ) ? (int) $d['id'] : 0;
	$p  = $id > 0 ? wc_get_product( $id ) : null;
	if ( ! $p || ! in_array( $p->get_type(), array( 'simple', 'variable', 'variation' ), true ) ) {
		return wkdigital_fehler( 404, 'product_not_found', 'Produkt nicht gefunden.' );
	}
	return wkdigital_antwort( 200, array( 'ok' => true, 'product' => wkdigital_produkt( $p ) ) );
}

/** Woerter zum Vergleichen: klein, ss statt ß, ohne Satzzeichen. */
function wkdigital_woerter( $text ) {
	$t = mb_strtolower( html_entity_decode( (string) $text, ENT_QUOTES, 'UTF-8' ), 'UTF-8' );
	$t = str_replace( 'ß', 'ss', $t );
	return array_values( array_filter( preg_split( '/[^\p{L}\p{N}]+/u', $t ) ) );
}

/**
 * Suche wie im PrestaShop-Modul: jedes Wort muss in Name, SKU oder einem Kategorienamen vorkommen, reine
 * Zahlen nur als ganze Zahl ("33" trifft nicht "330"). Gesucht werden Produkte, keine Varianten, auch
 * nicht veroeffentlichte ("active" sagt, ob kaufbar). Ganzer Suchtext im Namen zuerst, dann die neuesten.
 */
function wkdigital_suche( array $d ) {
	$q = trim( (string) ( $d['q'] ?? '' ) );
	if ( '' === $q || strlen( $q ) > 200 ) {
		return wkdigital_fehler( 400, 'bad_query', 'Suchbegriff fehlt oder ist zu lang.' );
	}
	$woerter = wkdigital_woerter( $q );
	if ( ! $woerter ) {
		return wkdigital_antwort( 200, array( 'ok' => true, 'products' => array() ) );
	}
	// Vorauswahl ueber das genaueste Wort: eine Zahl, sonst das laengste.
	$zahlen = array_values( array_filter( $woerter, 'ctype_digit' ) );
	if ( $zahlen ) {
		$vor = $zahlen[0];
	} else {
		$vor = $woerter[0];
		foreach ( $woerter as $w ) {
			if ( strlen( $w ) > strlen( $vor ) ) {
				$vor = $w;
			}
		}
	}
	$ids = wc_get_products( array(
		's'       => $vor,
		'limit'   => 400,
		'status'  => array( 'publish', 'private', 'draft', 'pending' ),
		'type'    => array( 'simple', 'variable' ),
		'orderby' => 'date',
		'order'   => 'DESC',
		'return'  => 'ids',
	) );
	$treffer = array();
	foreach ( $ids as $id ) {
		$p = wc_get_product( $id );
		if ( ! $p ) {
			continue;
		}
		$kat    = wp_get_post_terms( $id, 'product_cat', array( 'fields' => 'names' ) );
		$felder = wkdigital_woerter( $p->get_name() . ' ' . $p->get_sku() . ' ' . ( is_array( $kat ) ? implode( ' ', $kat ) : '' ) );
		$alle   = true;
		foreach ( $woerter as $w ) {
			$da = ctype_digit( $w ) ? in_array( $w, $felder, true ) : (bool) array_filter( $felder, function ( $f ) use ( $w ) {
				return false !== strpos( $f, $w );
			} );
			if ( ! $da ) {
				$alle = false;
				break;
			}
		}
		if ( ! $alle ) {
			continue;
		}
		$name_woerter = implode( ' ', wkdigital_woerter( $p->get_name() ) );
		$treffer[]    = array(
			'genau' => false !== strpos( $name_woerter, implode( ' ', $woerter ) ) ? 1 : 0,
			'p'     => $p,
		);
		if ( count( $treffer ) >= 60 ) {
			break;
		}
	}
	// Stabil: genaue Treffer zuerst, sonst die Reihenfolge der Abfrage (neueste zuerst).
	$genau  = array_filter( $treffer, function ( $t ) {
		return 1 === $t['genau'];
	} );
	$andere = array_filter( $treffer, function ( $t ) {
		return 0 === $t['genau'];
	} );
	$out = array();
	foreach ( array_slice( array_merge( array_values( $genau ), array_values( $andere ) ), 0, 20 ) as $t ) {
		$out[] = wkdigital_produkt( $t['p'] );
	}
	return wkdigital_antwort( 200, array( 'ok' => true, 'products' => $out ) );
}

/**
 * Ein reines Heftprodukt zum variablen Produkt mit "Ebook, Heft" machen, wie die bestehenden E-Book-
 * Produkte: Variante "Heft" mit Preis und Bestand des Produkts; Gewicht, Masse, Versand- und Steuerklasse
 * erbt sie vom Produkt. Die SKU des Produkts bleibt am Produkt.
 */
function wkdigital_zu_varianten( WC_Product $p ) {
	$id      = $p->get_id();
	$regular = $p->get_regular_price();
	$sale    = $p->get_sale_price();
	$manage  = $p->get_manage_stock();
	$bestand = $p->get_stock_quantity();
	$lager   = $p->get_stock_status();
	$nach    = $p->get_backorders();

	wp_set_object_terms( $id, 'variable', 'product_type' );
	wc_delete_product_transients( $id );
	$var  = new WC_Product_Variable( $id );
	$attr = new WC_Product_Attribute();
	$attr->set_id( 0 );
	$attr->set_name( WKDIGITAL_ATTR_NAME );
	$attr->set_options( array( WKDIGITAL_EBOOK, WKDIGITAL_HEFT ) );
	$attr->set_position( 0 );
	$attr->set_visible( true );
	$attr->set_variation( true );
	$attrs                    = $var->get_attributes();
	$attrs[ WKDIGITAL_ATTR ] = $attr;
	$var->set_attributes( $attrs );
	$var->set_manage_stock( false );
	$var->save();

	$heft = new WC_Product_Variation();
	$heft->set_parent_id( $id );
	$heft->set_attributes( array( WKDIGITAL_ATTR => WKDIGITAL_HEFT ) );
	$heft->set_regular_price( $regular );
	$heft->set_sale_price( $sale );
	$heft->set_manage_stock( $manage );
	if ( $manage ) {
		$heft->set_stock_quantity( $bestand );
		$heft->set_backorders( $nach );
	}
	$heft->set_stock_status( $lager );
	$heft->set_status( 'publish' );
	$heft->save();
	return wc_get_product( $id );
}

/**
 * E-Book-Variante anlegen oder aendern (idempotent ueber die SKU). available=false wirkt wie
 * withdraw_digital. Fehler: product_not_found, bad_sku, bad_price, sku_in_use, has_other_combinations,
 * product_virtual.
 */
function wkdigital_anbieten( array $d ) {
	$id         = isset( $d['id_product'] ) && is_numeric( $d['id_product'] ) ? (int) $d['id_product'] : 0;
	$sku        = trim( (string) ( $d['sku'] ?? '' ) );
	$preis      = isset( $d['price_gross'] ) && is_numeric( $d['price_gross'] ) ? round( (float) $d['price_gross'], 2 ) : 0;
	$verfuegbar = ! isset( $d['available'] ) || (bool) $d['available'];
	if ( ! preg_match( WKDIGITAL_SKU_MUSTER, $sku ) ) {
		return wkdigital_fehler( 400, 'bad_sku', 'Artikelnummer ungültig (A–Z a–z 0–9 . _ -, höchstens 64).' );
	}
	if ( $preis <= 0 || $preis > 1000 ) {
		return wkdigital_fehler( 400, 'bad_price', 'Preis ungültig.' );
	}
	$p = $id > 0 ? wc_get_product( $id ) : null;
	if ( ! $p || ! in_array( $p->get_type(), array( 'simple', 'variable' ), true ) ) {
		return wkdigital_fehler( 404, 'product_not_found', 'Produkt nicht gefunden.' );
	}
	$warnungen = array();
	if ( $p->is_type( 'simple' ) ) {
		if ( $p->is_virtual() || $p->is_downloadable() ) {
			return wkdigital_fehler( 409, 'product_virtual', 'Das Produkt ist schon virtuell; ein E-Book gehört an ein Heft.' );
		}
		$p = wkdigital_zu_varianten( $p );
		$warnungen[] = 'Das Produkt hat jetzt die Varianten Heft und E-Book.';
	}
	foreach ( $p->get_attributes() as $schluessel => $a ) {
		if ( WKDIGITAL_ATTR !== $schluessel && $a->get_variation() ) {
			return wkdigital_fehler( 409, 'has_other_combinations', 'Das Produkt hat schon andere Varianten.' );
		}
	}
	$attrs = $p->get_attributes();
	if ( ! isset( $attrs[ WKDIGITAL_ATTR ] ) ) {
		return wkdigital_fehler( 409, 'has_other_combinations', 'Das Produkt hat Varianten ohne „Ebook, Heft“.' );
	}
	if ( ! in_array( WKDIGITAL_EBOOK, $attrs[ WKDIGITAL_ATTR ]->get_options(), true ) ) {
		$attrs[ WKDIGITAL_ATTR ]->set_options( array_merge( array( WKDIGITAL_EBOOK ), $attrs[ WKDIGITAL_ATTR ]->get_options() ) );
		$p->set_attributes( $attrs );
		$p->save();
	}

	$ebook = wkdigital_variante( $p, WKDIGITAL_EBOOK );
	$fremd = wc_get_product_id_by_sku( $sku );
	if ( $fremd && ( ! $ebook || (int) $fremd !== $ebook->get_id() ) ) {
		return wkdigital_fehler( 409, 'sku_in_use', 'Die Artikelnummer ist im Laden schon vergeben.' );
	}
	if ( ! $ebook ) {
		$ebook = new WC_Product_Variation();
		$ebook->set_parent_id( $p->get_id() );
		$ebook->set_attributes( array( WKDIGITAL_ATTR => WKDIGITAL_EBOOK ) );
	}
	try {
		$ebook->set_sku( $sku );
	} catch ( WC_Data_Exception $e ) {
		return wkdigital_fehler( 409, 'sku_in_use', 'Die Artikelnummer ist im Laden schon vergeben.' );
	}
	$ebook->set_regular_price( wc_format_decimal( $preis, 2 ) );
	$ebook->set_sale_price( '' );
	$ebook->set_virtual( true );
	// Herunterladbar, auch ohne Datei: dann fragt Germanized an der Kasse den Verzicht auf das
	// Widerrufsrecht bei digitalen Inhalten ab (Haekchen "download").
	$ebook->set_downloadable( true );
	$ebook->set_sold_individually( true );
	$ebook->set_manage_stock( false );
	$ebook->set_stock_status( 'instock' );
	$ebook->set_status( $verfuegbar ? 'publish' : 'private' );
	$ebook->update_meta_data( WKDIGITAL_META_SKU, $sku );
	$ebook->save();
	WC_Product_Variable::sync( $p->get_id() );
	wc_delete_product_transients( $p->get_id() );

	$ebook = wc_get_product( $ebook->get_id() );
	$ist   = wkdigital_euro( $ebook->get_price() );
	if ( null !== $ist && abs( $ist - $preis ) > 0.004 ) {
		$warnungen[] = 'Der Laden verlangt ' . number_format( $ist, 2, ',', '.' ) . ' € statt ' . number_format( $preis, 2, ',', '.' ) . ' €.';
	}
	return wkdigital_antwort( 200, array(
		'ok'                   => true,
		'id_product_attribute' => $ebook->get_id(),
		'available'            => $verfuegbar && 'publish' === $p->get_status(),
		'price_gross'          => $ist,
		'url'                  => add_query_arg( 'attribute_' . WKDIGITAL_ATTR, WKDIGITAL_EBOOK, get_permalink( $p->get_id() ) ),
		'warnings'             => $warnungen,
	) );
}

/** E-Book-Variante ausblenden (privat: nicht mehr kaufbar). Bestellungen und Freischaltungen bleiben. */
function wkdigital_zuruecknehmen( array $d ) {
	$id  = isset( $d['id_product'] ) && is_numeric( $d['id_product'] ) ? (int) $d['id_product'] : 0;
	$sku = trim( (string) ( $d['sku'] ?? '' ) );
	$p   = $id > 0 ? wc_get_product( $id ) : null;
	if ( ! $p ) {
		return wkdigital_fehler( 404, 'product_not_found', 'Produkt nicht gefunden.' );
	}
	$ebook = wkdigital_variante( $p, WKDIGITAL_EBOOK );
	if ( $ebook && ( '' === $sku || $sku === $ebook->get_sku() ) ) {
		$ebook->set_status( 'private' );
		$ebook->save();
		WC_Product_Variable::sync( $p->get_id() );
		wc_delete_product_transients( $p->get_id() );
	}
	return wkdigital_antwort( 200, array( 'ok' => true, 'id_product_attribute' => null, 'available' => false ) );
}

/* ------------------------------------------------------------------------------------------------
 * Warenkorb aus dem Leser
 * --------------------------------------------------------------------------------------------- */

add_action( 'template_redirect', 'wkdigital_warenkorb', 5 );

function wkdigital_warenkorb() {
	if ( empty( $_GET['wkdigital-warenkorb'] ) || ! function_exists( 'WC' ) ) {
		return;
	}
	nocache_headers();
	if ( null === WC()->cart && function_exists( 'wc_load_cart' ) ) {
		wc_load_cart();
	}
	$roh  = (string) wp_unslash( $_GET['artikel'] ?? '' );
	$skus = array_slice( array_values( array_unique( array_filter( array_map( 'trim', explode( ',', $roh ) ) ) ) ), 0, 50 );
	$drin = array();
	foreach ( WC()->cart->get_cart() as $pos ) {
		$drin[ (int) $pos['variation_id'] ] = true;
	}
	$fehlt = 0;
	foreach ( $skus as $sku ) {
		if ( ! preg_match( WKDIGITAL_SKU_MUSTER, $sku ) ) {
			$fehlt++;
			continue;
		}
		$vid = (int) wc_get_product_id_by_sku( $sku );
		$v   = $vid ? wc_get_product( $vid ) : null;
		if ( ! $v || ! $v->is_type( 'variation' ) || $sku !== (string) $v->get_meta( WKDIGITAL_META_SKU ) || ! $v->is_purchasable() ) {
			$fehlt++;
			continue;
		}
		if ( isset( $drin[ $vid ] ) ) {
			continue;
		}
		if ( WC()->cart->add_to_cart( $v->get_parent_id(), 1, $vid, $v->get_variation_attributes() ) ) {
			$drin[ $vid ] = true;
		} else {
			$fehlt++;
		}
	}
	$email = sanitize_email( (string) wp_unslash( $_GET['email'] ?? '' ) );
	if ( $email && is_email( $email ) && WC()->customer && ! is_user_logged_in() ) {
		WC()->customer->set_billing_email( $email );
		WC()->customer->save();
	}
	if ( $fehlt ) {
		wc_add_notice( 'Nicht jedes E-Book ließ sich in den Warenkorb legen. Bitte prüfen Sie den Warenkorb.', 'notice' );
	}
	if ( WC()->session ) {
		WC()->session->set_customer_session_cookie( true );
	}
	wp_safe_redirect( WC()->cart->is_empty() ? wc_get_cart_url() : wc_get_checkout_url() );
	exit;
}

/* ------------------------------------------------------------------------------------------------
 * Freischaltung im Leser
 * --------------------------------------------------------------------------------------------- */

/** Die Artikelnummer bleibt an der Bestellposition, auch wenn das Produkt spaeter geaendert wird. */
add_action( 'woocommerce_checkout_create_order_line_item', function ( $item, $key, $values, $order ) {
	$p   = $values['data'] ?? null;
	$sku = $p instanceof WC_Product ? (string) $p->get_meta( WKDIGITAL_META_SKU ) : '';
	if ( '' !== $sku ) {
		$item->add_meta_data( WKDIGITAL_META_SKU, $sku, true );
	}
}, 10, 4 );

/** Positionen mit E-Book fuer den Leser; mit $nur_erstattete nur die voll erstatteten. */
function wkdigital_positionen( WC_Order $order, $nur_erstattete = false ) {
	$items = array();
	foreach ( $order->get_items() as $item_id => $item ) {
		$sku = (string) $item->get_meta( WKDIGITAL_META_SKU );
		if ( '' === $sku ) {
			$p   = $item->get_product();
			$sku = $p ? (string) $p->get_meta( WKDIGITAL_META_SKU ) : '';
		}
		if ( '' === $sku ) {
			continue;
		}
		if ( $nur_erstattete && abs( (int) $order->get_qty_refunded_for_item( $item_id ) ) < (int) $item->get_quantity() ) {
			continue;
		}
		$items[] = array( 'sku' => $sku, 'lineId' => (string) $item_id );
	}
	return $items;
}

add_action( 'woocommerce_order_status_changed', function ( $order_id, $von, $nach, $order ) {
	if ( ! $order instanceof WC_Order ) {
		$order = wc_get_order( $order_id );
	}
	if ( ! $order ) {
		return;
	}
	if ( in_array( $nach, array( 'processing', 'completed' ), true ) ) {
		wkdigital_melden( $order, 'grant' );
	} elseif ( in_array( $nach, array( 'refunded', 'cancelled' ), true ) ) {
		wkdigital_melden( $order, 'revoke' );
	}
}, 20, 4 );

add_action( 'woocommerce_order_partially_refunded', function ( $order_id ) {
	$order = wc_get_order( $order_id );
	if ( $order ) {
		wkdigital_melden( $order, 'revoke', true );
	}
}, 20, 1 );

/** Bestellung an den Leser melden (Vertrag v2). Wahr, wenn gemeldet oder nichts zu melden war. */
function wkdigital_melden( WC_Order $order, $aktion, $nur_erstattete = false ) {
	$items = wkdigital_positionen( $order, $nur_erstattete );
	if ( ! $items ) {
		return true;
	}
	$rumpf = wp_json_encode( array(
		'externalOrderId'    => (string) $order->get_order_number(),
		'externalCustomerId' => (string) $order->get_customer_id(),
		'email'              => strtolower( trim( (string) $order->get_billing_email() ) ),
		'action'             => $aktion,
		'items'              => $items,
	), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
	return wkdigital_senden( $rumpf, $order->get_id(), 1 );
}

/**
 * Einen Rumpf an den Leser schicken. Bei Netzfehler oder 5xx spaeter erneut (WP-Cron, wachsende
 * Abstaende, hoechstens 20 Versuche); der Leser wirkt je Position und Aktion genau einmal.
 */
function wkdigital_senden( $rumpf, $order_id, $versuch ) {
	$geheimnis = wkdigital_geheimnis();
	$order     = wc_get_order( $order_id );
	$was       = json_decode( $rumpf, true );
	$anzahl    = is_array( $was['items'] ?? null ) ? count( $was['items'] ) : 0;
	$art       = 'grant' === ( $was['action'] ?? '' ) ? 'freigeschaltet' : 'zurückgenommen';
	if ( '' === $geheimnis ) {
		if ( $order ) {
			$order->add_order_note( 'Weltkrieg Digital: nicht gemeldet, Geheimnis fehlt (Option wkdigital_secret).' );
		}
		return false;
	}
	$antwort = wp_remote_post( WKDIGITAL_LESER . '/hooks/shop/entitlements', array(
		'timeout'     => 15,
		'redirection' => 0,
		'headers'     => array(
			'content-type'     => 'application/json',
			'x-shop-signature' => hash_hmac( 'sha256', $rumpf, $geheimnis ),
		),
		'body'        => $rumpf,
	) );
	$code = is_wp_error( $antwort ) ? 0 : (int) wp_remote_retrieve_response_code( $antwort );
	if ( 200 === $code ) {
		if ( $order ) {
			$order->add_order_note( sprintf( 'Weltkrieg Digital: %d E-Book%s im Leser %s.', $anzahl, 1 === $anzahl ? '' : 's', $art ) );
		}
		return true;
	}
	$grund = is_wp_error( $antwort ) ? $antwort->get_error_message() : 'HTTP ' . $code;
	error_log( 'wk-digital: Meldung an den Leser fehlgeschlagen (' . $grund . '), Bestellung ' . $order_id );
	if ( $code >= 400 && $code < 500 ) {
		if ( $order ) {
			$order->add_order_note( 'Weltkrieg Digital: Meldung abgelehnt (' . $grund . '). Bitte prüfen.' );
		}
		return false;
	}
	if ( $versuch >= WKDIGITAL_MAX_VERSUCHE ) {
		if ( $order ) {
			$order->add_order_note( 'Weltkrieg Digital: Meldung nach ' . $versuch . ' Versuchen aufgegeben (' . $grund . ').' );
		}
		return false;
	}
	$schlange   = (array) get_option( WKDIGITAL_NACHSENDEN, array() );
	$schlange[] = array(
		'rumpf'   => $rumpf,
		'order'   => (int) $order_id,
		'versuch' => $versuch + 1,
		'ab'      => time() + min( 6 * HOUR_IN_SECONDS, 300 * ( 2 ** ( $versuch - 1 ) ) ),
	);
	update_option( WKDIGITAL_NACHSENDEN, $schlange, false );
	if ( ! wp_next_scheduled( WKDIGITAL_NACHSENDEN ) ) {
		wp_schedule_single_event( time() + 300, WKDIGITAL_NACHSENDEN );
	}
	if ( $order && 1 === $versuch ) {
		$order->add_order_note( 'Weltkrieg Digital: Leser nicht erreichbar (' . $grund . '), wird wiederholt.' );
	}
	return false;
}

add_action( WKDIGITAL_NACHSENDEN, function () {
	$schlange = (array) get_option( WKDIGITAL_NACHSENDEN, array() );
	update_option( WKDIGITAL_NACHSENDEN, array(), false );
	$jetzt = time();
	foreach ( $schlange as $eintrag ) {
		if ( ! is_array( $eintrag ) || empty( $eintrag['rumpf'] ) ) {
			continue;
		}
		if ( (int) ( $eintrag['ab'] ?? 0 ) > $jetzt ) {
			$rest   = (array) get_option( WKDIGITAL_NACHSENDEN, array() );
			$rest[] = $eintrag;
			update_option( WKDIGITAL_NACHSENDEN, $rest, false );
			continue;
		}
		wkdigital_senden( (string) $eintrag['rumpf'], (int) $eintrag['order'], (int) $eintrag['versuch'] );
	}
	$offen = (array) get_option( WKDIGITAL_NACHSENDEN, array() );
	if ( $offen && ! wp_next_scheduled( WKDIGITAL_NACHSENDEN ) ) {
		wp_schedule_single_event( time() + 300, WKDIGITAL_NACHSENDEN );
	}
} );

/* ------------------------------------------------------------------------------------------------
 * Hinweis fuer den Kunden: wo und mit welcher Adresse er liest
 * --------------------------------------------------------------------------------------------- */

function wkdigital_hinweis_html( WC_Order $order ) {
	return '<p style="margin:16px 0"><strong>Ihre E-Books lesen Sie im Leser von Weltkrieg Digital:</strong> '
		. '<a href="' . esc_url( WKDIGITAL_LESER . '/library' ) . '">digital.weltkrieg-online.de</a>. '
		. 'Melden Sie sich dort mit <strong>' . esc_html( $order->get_billing_email() ) . '</strong> an; '
		. 'ein Passwort brauchen Sie nicht, Sie bekommen einen Anmeldelink per E-Mail.</p>';
}

add_action( 'woocommerce_thankyou', function ( $order_id ) {
	$order = wc_get_order( $order_id );
	if ( $order && wkdigital_positionen( $order ) ) {
		echo '<section class="wkdigital-hinweis">' . wkdigital_hinweis_html( $order ) . '</section>'; // phpcs:ignore WordPress.Security.EscapeOutput
	}
}, 20 );

add_action( 'woocommerce_email_order_details', function ( $order, $an_admin, $nur_text, $email = null ) {
	if ( $an_admin || ! $order instanceof WC_Order || ! wkdigital_positionen( $order ) ) {
		return;
	}
	if ( $email && ! in_array( $email->id, array( 'customer_processing_order', 'customer_completed_order', 'customer_on_hold_order' ), true ) ) {
		return;
	}
	if ( $nur_text ) {
		echo "\nIhre E-Books lesen Sie unter " . WKDIGITAL_LESER . '/library' . "\nMelden Sie sich dort mit " . $order->get_billing_email() . " an.\n\n"; // phpcs:ignore WordPress.Security.EscapeOutput
	} else {
		echo wkdigital_hinweis_html( $order ); // phpcs:ignore WordPress.Security.EscapeOutput
	}
}, 5, 4 );
