<?php
/**
 * Aktion "heft_mail" der Shop-API: der Leser (digital.lesenundschenken.de)
 * kündigt ein neu veröffentlichtes Heft bei allen an, die schon Digitalhefte
 * gekauft haben (convex/heftAnkuendigung.ts). Er baut Betreff, HTML und Text
 * selbst; der Shop verschickt über das lokale Postfix mit DKIM.
 *
 * Damit die signierte Schnittstelle kein allgemeiner Mailversand wird:
 *  - jede Adresse in href/src muss auf den Leser zeigen, keine Skripte,
 *    Formulare oder eingebetteten Objekte,
 *  - die Abmeldeadresse (Kopf List-Unsubscribe, RFC 8058) zeigt auf den Leser,
 *  - höchstens 6 solcher Mails je Empfänger und Tag, dazu die 5 je Stunde aller
 *    Lesermails (Tabelle ps_lusdigital_mail, Empfänger nur als SHA-256).
 *
 * Der Shop stellt allen Betreffs "[Lesen und Schenken]" voran
 * (PS_MAIL_SUBJECT_PREFIX); für diese Mails setzt der Hook
 * actionMailAlterMessageBeforeSend in lusdigital.php den Betreff zurück und
 * die Abmelde-Kopfzeilen dazu. Er greift nur, solange $kopf gesetzt ist.
 *
 * Rumpf: {"action":"heft_mail","to":"…","subject":"…","html":"…","text":"…",
 *         "from_name":"…","unsubscribe":"https://digital.lesenundschenken.de/hooks/mail/abbestellen?t=…&r=…","ts":…}
 * Antwort: {"ok":true} oder {"ok":false,"error":"bad_email|bad_subject|bad_content|bad_link|rate_limited|mail_failed","message":"…"}
 */
if (!defined('_PS_VERSION_')) {
    exit;
}

require_once _PS_MODULE_DIR_ . 'lusdigital/classes/LusdigitalLoginMail.php';

class LusdigitalHeftMail
{
    const VORLAGE = 'lusdigital_heft';
    const LINK_PRAEFIXE = ['https://digital.lesenundschenken.de/', 'https://lesen.lesenundschenken.de/'];
    const ABMELDE_PFAD = 'hooks/mail/abbestellen?';
    const MAX_PRO_TAG = 6;
    const MAX_PRO_STUNDE = 5;
    const MAX_HTML = 300000;
    const MAX_TEXT = 100000;

    /** Für den Hook: Betreff und Abmeldeadresse der Mail, die gerade hinausgeht. */
    public static $kopf = null;

    /**
     * @return array [HTTP-Status, Antwort]
     */
    public static function senden(array $d)
    {
        $an = Tools::strtolower(trim((string) ($d['to'] ?? '')));
        if ($an === '' || Tools::strlen($an) > 254 || !Validate::isEmail($an)) {
            return self::fehler(400, 'bad_email', 'Empfängeradresse ungültig.');
        }

        $betreff = trim((string) ($d['subject'] ?? ''));
        if ($betreff === '' || Tools::strlen($betreff) > 200 || preg_match('/[\x00-\x1f\x7f<>]/u', $betreff)) {
            return self::fehler(400, 'bad_subject', 'Betreff fehlt oder enthält unzulässige Zeichen.');
        }

        $absender = trim((string) ($d['from_name'] ?? ''));
        if (Tools::strlen($absender) > 80 || preg_match('/[\x00-\x1f\x7f<>"]/u', $absender)) {
            return self::fehler(400, 'bad_subject', 'Absendername enthält unzulässige Zeichen.');
        }

        $html = (string) ($d['html'] ?? '');
        $text = (string) ($d['text'] ?? '');
        if ($html === '' || strlen($html) > self::MAX_HTML || $text === '' || strlen($text) > self::MAX_TEXT) {
            return self::fehler(400, 'bad_content', 'HTML oder Text fehlt oder ist zu lang.');
        }
        if (!mb_check_encoding($html, 'UTF-8') || !mb_check_encoding($text, 'UTF-8')) {
            return self::fehler(400, 'bad_content', 'Inhalt ist kein UTF-8.');
        }
        if (preg_match('/<\s*(script|iframe|object|embed|form|input|button|link|meta\s+http-equiv)\b|javascript:|\son[a-z]+\s*=/i', $html)) {
            return self::fehler(400, 'bad_content', 'Inhalt enthält Skripte, Formulare oder eingebettete Objekte.');
        }
        // Alle Verweise und Bilder zeigen auf den Leser; nur in Anführungszeichen.
        preg_match_all('/\s(?:href|src|background)\s*=\s*(["\']?)([^"\'\s>]*)\1/i', $html, $treffer, PREG_SET_ORDER);
        foreach ($treffer as $t) {
            if ($t[1] === '' || !self::leserLink(html_entity_decode($t[2], ENT_QUOTES | ENT_HTML5, 'UTF-8'))) {
                return self::fehler(400, 'bad_link', 'Jeder Verweis muss auf https://digital.lesenundschenken.de/ zeigen.');
            }
        }
        if (preg_match('/url\s*\(/i', $html)) {
            return self::fehler(400, 'bad_content', 'Keine Bilder aus Stilangaben.');
        }

        $abmelden = (string) ($d['unsubscribe'] ?? '');
        if (!self::leserLink($abmelden) || strpos($abmelden, self::ABMELDE_PFAD) === false) {
            return self::fehler(400, 'bad_link', 'Die Abmeldeadresse muss auf den Leser zeigen.');
        }

        LusdigitalLoginMail::tabelleAnlegen();
        $db = Db::getInstance();
        $tabelle = _DB_PREFIX_ . 'lusdigital_mail';
        $hash = hash('sha256', $an);
        $proStunde = (int) $db->getValue(
            'SELECT COUNT(*) FROM `' . $tabelle . '` WHERE empfaenger_hash = "' . pSQL($hash) . '"'
            . ' AND gesendet_am > DATE_SUB(NOW(), INTERVAL 1 HOUR)'
        );
        $proTag = (int) $db->getValue(
            'SELECT COUNT(*) FROM `' . $tabelle . '` WHERE empfaenger_hash = "' . pSQL($hash) . '"'
            . ' AND vorlage = "' . pSQL(self::VORLAGE) . '" AND gesendet_am > DATE_SUB(NOW(), INTERVAL 1 DAY)'
        );
        if ($proStunde >= self::MAX_PRO_STUNDE || $proTag >= self::MAX_PRO_TAG) {
            return self::fehler(429, 'rate_limited', 'Zu viele Mails an diese Adresse.');
        }

        // Vor dem Senden zählen: auch ein fehlgeschlagener Versuch zählt.
        $db->insert('lusdigital_mail', [
            'empfaenger_hash' => pSQL($hash),
            'vorlage' => pSQL(self::VORLAGE),
            'gesendet_am' => date('Y-m-d H:i:s'),
            'ok' => 0,
        ]);
        $id = (int) $db->Insert_ID();

        $idLang = (int) Language::getIdByIso('de') ?: (int) Configuration::get('PS_LANG_DEFAULT');
        self::$kopf = ['betreff' => $betreff, 'abmelden' => $abmelden];
        try {
            $ok = Mail::send(
                $idLang,
                self::VORLAGE,
                $betreff,
                ['{inhalt_html}' => $html, '{inhalt_text}' => $text],
                $an,
                null,
                null,
                $absender !== '' ? $absender : null,
                null,
                null,
                _PS_MODULE_DIR_ . 'lusdigital/mails/',
                false,
                (int) Context::getContext()->shop->id
            );
        } finally {
            self::$kopf = null;
        }
        if (!$ok) {
            PrestaShopLogger::addLog('lusdigital heft_mail: Mail::send fehlgeschlagen', 3, null, null, null, true);

            return self::fehler(502, 'mail_failed', 'Der Shop konnte die Mail nicht versenden.');
        }
        $db->update('lusdigital_mail', ['ok' => 1], 'id_lusdigital_mail = ' . $id);

        return [200, ['ok' => true]];
    }

    /** Aus dem Hook actionMailAlterMessageBeforeSend (lusdigital.php). */
    public static function kopfSetzen($nachricht)
    {
        if (self::$kopf === null || !is_object($nachricht) || !method_exists($nachricht, 'getHeaders')) {
            return;
        }
        $nachricht->subject(self::$kopf['betreff']);
        $kopf = $nachricht->getHeaders();
        $kopf->addTextHeader('List-Unsubscribe', '<' . self::$kopf['abmelden'] . '>');
        $kopf->addTextHeader('List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
        $kopf->addTextHeader('Auto-Submitted', 'auto-generated');
    }

    protected static function leserLink($url)
    {
        if (strlen($url) > 1000 || preg_match('/[\s<>"\'\\\\\x00-\x1f\x7f]/', $url) || !filter_var($url, FILTER_VALIDATE_URL)) {
            return false;
        }
        foreach (self::LINK_PRAEFIXE as $praefix) {
            if (strpos($url, $praefix) === 0) {
                return true;
            }
        }

        return false;
    }

    protected static function fehler($status, $kennung, $text)
    {
        return [$status, ['ok' => false, 'error' => $kennung, 'message' => $text]];
    }
}
