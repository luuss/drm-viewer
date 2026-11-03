<?php
/**
 * Plugin Name: WK — Digital-Leser
 * Description: Shop-API fuer den Leser digital.weltkrieg-online.de. Gegenstueck zum PrestaShop-Modul
 *              lusdigital (lesenundschenken.de): gleicher Vertrag, gleiche Signatur. Bisher nur die
 *              Aktion "send_mail" (Anmeldelink), weil der Leser keinen eigenen Mailversand hat.
 *              Quelle: drm-viewer/deploy/weltkrieg/wk-digital.php, Doku drm-viewer/docs/weltkrieg-digital.md.
 * Version: 1.0
 * Author: WK
 *
 * POST https://weltkrieg-online.de/wp-json/wkdigital/v1/api
 * Rumpf:  JSON mit "action" und "ts" (Unix-Sekunden).
 * Header: x-shop-signature = hex(HMAC-SHA256(roher Rumpf, Geheimnis)).
 * Geheimnis: Option "wkdigital_secret" (gleich SHOP_WEBHOOK_SECRET im Leser), setzen per
 *   wp option update wkdigital_secret "$(cat datei)" --autoload=no
 * Ohne Geheimnis antwortet die Schnittstelle 403 not_configured.
 */

defined( 'ABSPATH' ) || exit;

const WKDIGITAL_ZEITFENSTER   = 300;
const WKDIGITAL_LINK_PRAEFIX  = 'https://digital.weltkrieg-online.de/';
const WKDIGITAL_MAX_PRO_STUNDE = 5;
const WKDIGITAL_GUELTIG_MIN   = 15;
const WKDIGITAL_ABSENDER      = 'versand@weltkrieg-online.de';
const WKDIGITAL_ABSENDER_NAME = 'Weltkrieg Digital';

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

function wkdigital_api( WP_REST_Request $request ) {
	$geheimnis = (string) get_option( 'wkdigital_secret', '' );
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

	switch ( (string) ( $d['action'] ?? '' ) ) {
		case 'send_mail':
			return wkdigital_anmeldelink( $d );
		case 'search':
		case 'product':
		case 'offer_digital':
		case 'withdraw_digital':
		case 'heft_mail':
		case 'quote':
		case 'create_order':
		case 'refund_order':
			return wkdigital_fehler( 501, 'not_implemented', 'Diese Aktion gibt es im Weltkrieg-Laden noch nicht.' );
		default:
			return wkdigital_fehler( 400, 'unknown_action', 'Unbekannte Aktion.' );
	}
}

/**
 * Anmeldelink verschicken. Eng begrenzt, damit die Schnittstelle kein allgemeiner Mailversand wird:
 * nur Vorlage "lusdigital_login" (Name kommt so aus dem Leser), nur Links auf digital.weltkrieg-online.de,
 * hoechstens 5 Mails je Empfaenger und Stunde (Zaehler als Transient, Empfaenger nur als SHA-256).
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
	if ( 0 !== strpos( $link, WKDIGITAL_LINK_PRAEFIX )
		|| strlen( $link ) > 1000
		|| preg_match( '/[\s<>"\'\\\\\x00-\x1f\x7f]/', $link )
		|| ! filter_var( $link, FILTER_VALIDATE_URL ) ) {
		return wkdigital_fehler( 400, 'bad_link', 'Der Link muss auf ' . WKDIGITAL_LINK_PRAEFIX . ' zeigen.' );
	}

	$schluessel = 'wkdigital_mail_' . substr( hash( 'sha256', $an ), 0, 40 );
	$jetzt      = time();
	$zeiten     = array_filter( (array) get_transient( $schluessel ), function ( $t ) use ( $jetzt ) {
		return is_int( $t ) && $t > $jetzt - HOUR_IN_SECONDS;
	} );
	if ( count( $zeiten ) >= WKDIGITAL_MAX_PRO_STUNDE ) {
		return wkdigital_fehler( 429, 'rate_limited', 'Zu viele Mails an diese Adresse in der letzten Stunde.' );
	}
	// Vor dem Senden zaehlen: auch ein fehlgeschlagener Versuch zaehlt.
	$zeiten[] = $jetzt;
	set_transient( $schluessel, array_values( $zeiten ), HOUR_IN_SECONDS );

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

	$absender = function ( $phpmailer ) {
		$phpmailer->Sender = WKDIGITAL_ABSENDER; // Envelope-From, damit SPF (a) greift
		$phpmailer->AltBody = wp_strip_all_tags( str_replace( array( '<br>', '</p>' ), "\n", $phpmailer->Body ) );
	};
	add_action( 'phpmailer_init', $absender );
	$ok = wp_mail(
		$an,
		'Ihr Anmeldelink für Weltkrieg Digital',
		$html,
		array(
			'Content-Type: text/html; charset=UTF-8',
			'From: ' . WKDIGITAL_ABSENDER_NAME . ' <' . WKDIGITAL_ABSENDER . '>',
		)
	);
	remove_action( 'phpmailer_init', $absender );

	if ( ! $ok ) {
		error_log( 'wk-digital send_mail: wp_mail fehlgeschlagen' );
		return wkdigital_fehler( 502, 'mail_failed', 'Der Shop konnte die Mail nicht versenden.' );
	}
	return wkdigital_antwort( 200, array( 'ok' => true ) );
}
