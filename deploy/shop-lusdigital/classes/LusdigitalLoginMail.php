<?php
/**
 * Aktion "send_mail" der Shop-API: der Leser (digital.lesenundschenken.de) hat
 * keinen eigenen Mailversand und lässt seine Anmeldelinks vom Shop schicken.
 * Der Shop versendet zuverlässig über das lokale Postfix, mit DKIM-Signatur
 * durch PrestaShop.
 *
 * Eng begrenzt, damit die signierte Schnittstelle kein allgemeiner
 * Mailversand wird:
 *  - nur die Vorlage "lusdigital_login" (mails/de/lusdigital_login.{html,txt}),
 *  - der Link muss mit https://digital.lesenundschenken.de/ beginnen (bis zum
 *    Umzug am 19.10.2026 lesen.lesenundschenken.de, das gilt weiter),
 *  - höchstens 5 Mails je Empfänger und Stunde (Tabelle ps_lusdigital_mail,
 *    Empfänger nur als SHA-256 gespeichert).
 *
 * Rumpf: {"action":"send_mail","template":"lusdigital_login","to":"…","link":"https://digital.lesenundschenken.de/anmelden?t=…","ts":…}
 * Antwort: {"ok":true} oder {"ok":false,"error":"bad_template|bad_email|bad_link|rate_limited|mail_failed","message":"…"}
 */
if (!defined('_PS_VERSION_')) {
    exit;
}

class LusdigitalLoginMail
{
    const VORLAGEN = ['lusdigital_login'];
    const LINK_PRAEFIXE = ['https://digital.lesenundschenken.de/', 'https://lesen.lesenundschenken.de/'];
    const MAX_PRO_STUNDE = 5;
    const GUELTIG_MINUTEN = 15;

    /**
     * @return array [HTTP-Status, Antwort]
     */
    public static function senden(array $d)
    {
        $vorlage = (string) ($d['template'] ?? '');
        if (!in_array($vorlage, self::VORLAGEN, true)) {
            return [400, ['ok' => false, 'error' => 'bad_template', 'message' => 'Unbekannte Mailvorlage.']];
        }

        $an = Tools::strtolower(trim((string) ($d['to'] ?? '')));
        if ($an === '' || Tools::strlen($an) > 254 || !Validate::isEmail($an)) {
            return [400, ['ok' => false, 'error' => 'bad_email', 'message' => 'Empfängeradresse ungültig.']];
        }

        $link = (string) ($d['link'] ?? '');
        $praefixOk = false;
        foreach (self::LINK_PRAEFIXE as $praefix) {
            if (strpos($link, $praefix) === 0) {
                $praefixOk = true;
            }
        }
        if (!$praefixOk
            || strlen($link) > 1000
            || preg_match('/[\s<>"\'\\\\\x00-\x1f\x7f]/', $link)
            || !filter_var($link, FILTER_VALIDATE_URL)
        ) {
            return [400, ['ok' => false, 'error' => 'bad_link', 'message' => 'Der Link muss auf https://digital.lesenundschenken.de/ zeigen.']];
        }

        self::tabelleAnlegen();
        $db = Db::getInstance();
        $tabelle = _DB_PREFIX_ . 'lusdigital_mail';
        $hash = hash('sha256', $an);
        $anzahl = (int) $db->getValue(
            'SELECT COUNT(*) FROM `' . $tabelle . '` WHERE empfaenger_hash = "' . pSQL($hash) . '"'
            . ' AND vorlage <> "lusdigital_heft" AND gesendet_am > DATE_SUB(NOW(), INTERVAL 1 HOUR)'
        );
        if ($anzahl >= self::MAX_PRO_STUNDE) {
            return [429, ['ok' => false, 'error' => 'rate_limited', 'message' => 'Zu viele Mails an diese Adresse in der letzten Stunde.']];
        }

        // Vor dem Senden zählen: auch ein fehlgeschlagener Versuch zählt.
        $db->insert('lusdigital_mail', [
            'empfaenger_hash' => pSQL($hash),
            'vorlage' => pSQL($vorlage),
            'gesendet_am' => date('Y-m-d H:i:s'),
            'ok' => 0,
        ]);
        $id = (int) $db->Insert_ID();

        $idLang = (int) Language::getIdByIso('de') ?: (int) Configuration::get('PS_LANG_DEFAULT');
        $ok = Mail::send(
            $idLang,
            $vorlage,
            'Ihr Anmeldelink für den Leser',
            [
                '{link}' => $link,
                '{link_html}' => htmlspecialchars($link, ENT_QUOTES, 'UTF-8'),
                '{gueltig_minuten}' => (string) self::GUELTIG_MINUTEN,
            ],
            $an,
            null,
            null,
            null,
            null,
            null,
            _PS_MODULE_DIR_ . 'lusdigital/mails/',
            false,
            (int) Context::getContext()->shop->id
        );
        if (!$ok) {
            PrestaShopLogger::addLog('lusdigital send_mail: Mail::send fehlgeschlagen', 3, null, null, null, true);

            return [502, ['ok' => false, 'error' => 'mail_failed', 'message' => 'Der Shop konnte die Mail nicht versenden.']];
        }
        $db->update('lusdigital_mail', ['ok' => 1], 'id_lusdigital_mail = ' . $id);
        // Alte Zeilen braucht niemand mehr.
        $db->execute('DELETE FROM `' . $tabelle . '` WHERE gesendet_am < DATE_SUB(NOW(), INTERVAL 7 DAY)');

        return [200, ['ok' => true]];
    }

    /** Die Tabelle entsteht beim ersten Aufruf; das Modul muss dafür nicht neu installiert werden. */
    public static function tabelleAnlegen()
    {
        Db::getInstance()->execute(
            'CREATE TABLE IF NOT EXISTS `' . _DB_PREFIX_ . 'lusdigital_mail` (
                `id_lusdigital_mail` INT UNSIGNED NOT NULL AUTO_INCREMENT,
                `empfaenger_hash` CHAR(64) NOT NULL,
                `vorlage` VARCHAR(64) NOT NULL,
                `gesendet_am` DATETIME NOT NULL,
                `ok` TINYINT(1) NOT NULL DEFAULT 0,
                PRIMARY KEY (`id_lusdigital_mail`),
                KEY `empfaenger_zeit` (`empfaenger_hash`, `gesendet_am`)
            ) ENGINE=' . _MYSQL_ENGINE_ . ' DEFAULT CHARSET=utf8mb4'
        );
    }
}
