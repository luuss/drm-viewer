/*
 * Alle .indd eines Ordners als .idml danebenlegen.
 *
 * In InDesign oeffnen ueber Fenster > Hilfsprogramme > Skripte, dort per
 * Doppelklick starten. Es fragt nach einem Ordner und arbeitet ihn samt
 * Unterordnern ab. Vorhandene .idml werden uebersprungen, die .indd bleiben
 * unveraendert (geschlossen wird ohne Speichern).
 *
 * Hintergrund: der Leseweg braucht den IDML-Export, weil sich nur dort
 * Stories, Absatzformate und Bildrahmen auslesen lassen. Die .indd ist ein
 * Binaerformat, das ausserhalb von InDesign niemand zuverlaessig liest.
 */
#target indesign

function idmlDatei(datei) {
    var name = datei.name.replace(/\.indd$/i, ".idml");
    return File(datei.path + "/" + name);
}

function sammeln(ordner, treffer) {
    var eintraege = ordner.getFiles();
    for (var i = 0; i < eintraege.length; i++) {
        var e = eintraege[i];
        if (e instanceof Folder) {
            sammeln(e, treffer);
        } else if (/\.indd$/i.test(e.name)) {
            treffer.push(e);
        }
    }
    return treffer;
}

function main() {
    var ordner = Folder.selectDialog("Ordner mit den InDesign-Dateien waehlen");
    if (!ordner) return;

    var dateien = sammeln(ordner, []);
    if (!dateien.length) {
        alert("Keine .indd-Datei in " + ordner.fsName + " gefunden.");
        return;
    }

    var fertig = 0, uebersprungen = 0, fehler = [];
    for (var i = 0; i < dateien.length; i++) {
        var quelle = dateien[i];
        var ziel = idmlDatei(quelle);
        if (ziel.exists) { uebersprungen++; continue; }

        var dok = null;
        try {
            // Ohne Fenster geht es schneller und stoert die Ansicht nicht.
            dok = app.open(quelle, false);
            dok.exportFile(ExportFormat.INDESIGN_MARKUP, ziel);
            fertig++;
        } catch (e) {
            fehler.push(quelle.name + ": " + e);
        } finally {
            if (dok !== null) {
                try { dok.close(SaveOptions.NO); } catch (e2) {}
            }
        }
    }

    var bericht = fertig + " Datei(en) als IDML gespeichert.";
    if (uebersprungen) bericht += "\n" + uebersprungen + " uebersprungen (IDML lag schon daneben).";
    if (fehler.length) bericht += "\n\nFehlgeschlagen:\n" + fehler.join("\n");
    alert(bericht);
}

main();
