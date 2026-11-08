"""PAYCALC - weekly payroll calculation (translated from PAYCALC.cob).

Reads one employee per line from stdin:
  cols 1-5   employee id
  cols 6-8   hours worked, whole hours 000-168
  cols 9-13  hourly rate in cents (02550 = 25.50)
A line starting with END, or a blank line, ends the input. Prints one pay
line per valid employee, an error line per invalid record, then totals.
Exit code 4 if any record had an error.
"""
import sys

from records import Decimal, cob_round, edit_z, fit_digits, pic_x

DIGITS = set("0123456789")


def is_numeric_x(text: str) -> bool:
    """IS NUMERIC on a PIC X field: every character is 0-9."""
    return text != "" and all(c in DIGITS for c in text)


class Totals:
    """WS-COUNT, WS-ERRORS, WS-TOTAL-GROSS, WS-TOTAL-NET (COBOL lines 29-32)."""

    def __init__(self) -> None:
        self.count = 0
        self.errors = 0
        self.gross = Decimal(0)
        self.net = Decimal(0)


def validate_record(in_id: str, in_hours: str, in_rate: str, out: list) -> tuple:
    """PROCESS-RECORD validation (COBOL lines 59-87).

    Returns (valid, hours, rate_cents). The id is checked first, then hours
    (numeric, at most 168), then the rate (numeric, not zero); the first
    failing check prints its error line.
    """
    hours = 0
    rate_cents = 0
    if in_id == " " * 5:
        out.append("ERROR ----- MISSING EMPLOYEE ID")
        return False, hours, rate_cents
    if not is_numeric_x(in_hours):
        out.append(f"ERROR {in_id} INVALID HOURS")
        return False, hours, rate_cents
    hours = int(in_hours)
    if hours > 168:
        out.append(f"ERROR {in_id} HOURS OVER 168")
        return False, hours, rate_cents
    if not is_numeric_x(in_rate):
        out.append(f"ERROR {in_id} INVALID RATE")
        return False, hours, rate_cents
    rate_cents = int(in_rate)
    if rate_cents == 0:
        out.append(f"ERROR {in_id} ZERO RATE")
        return False, hours, rate_cents
    return True, hours, rate_cents


def split_overtime(hours: int) -> tuple:
    """Hours over 40 are overtime (COBOL lines 96-103)."""
    if hours > 40:
        return 40, hours - 40
    return hours, 0


def gross_pay(hours: int, rate_cents: int) -> Decimal:
    """Gross = regular hours x rate + overtime hours x rate x 1.5, ROUNDED
    to cents (COBOL lines 95-106)."""
    rate = Decimal(rate_cents) / 100
    reg_hours, ot_hours = split_overtime(hours)
    gross = reg_hours * rate + ot_hours * rate * Decimal("1.5")
    return fit_digits(cob_round(gross, 2), 7, 2)


def tax_for(gross: Decimal) -> Decimal:
    """Marginal tax: 10% up to 500.00, 20% from 500.01 to 1500.00, 30% above
    1500.00, each ROUNDED to cents (COBOL lines 107-119)."""
    if gross <= 500:
        tax = gross * Decimal("0.10")
    elif gross <= 1500:
        tax = 50 + (gross - 500) * Decimal("0.20")
    else:
        tax = 250 + (gross - 1500) * Decimal("0.30")
    return fit_digits(cob_round(tax, 2), 7, 2)


def calc_pay(in_id: str, hours: int, rate_cents: int, totals: Totals, out: list) -> None:
    """CALC-PAY: gross, tax, net, running totals and the pay line
    (COBOL lines 94-128)."""
    gross = gross_pay(hours, rate_cents)
    tax = tax_for(gross)
    net = fit_digits(gross - tax, 7, 2)
    totals.count = int(fit_digits(Decimal(totals.count + 1), 5, 0))
    totals.gross = fit_digits(totals.gross + gross, 9, 2)
    totals.net = fit_digits(totals.net + net, 9, 2)
    out.append(f"PAY {in_id} GROSS {edit_z(gross, 6, 2)} TAX {edit_z(tax, 6, 2)} NET {edit_z(net, 6, 2)}")


def process_record(line: str, totals: Totals, out: list) -> None:
    """PROCESS-RECORD (COBOL lines 59-92): validate, count the error or pay."""
    in_id, in_hours, in_rate = line[0:5], line[5:8], line[8:13]
    valid, hours, rate_cents = validate_record(in_id, in_hours, in_rate, out)
    if not valid:
        totals.errors = int(fit_digits(Decimal(totals.errors + 1), 5, 0))
    else:
        calc_pay(in_id, hours, rate_cents, totals, out)


def print_totals(totals: Totals, out: list) -> None:
    """PRINT-TOTALS (COBOL lines 130-136)."""
    out.append(f"EMPLOYEES {edit_z(Decimal(totals.count), 4)} ERRORS {edit_z(Decimal(totals.errors), 4)}")
    out.append(f"TOTAL GROSS {edit_z(totals.gross, 8, 2)} TOTAL NET {edit_z(totals.net, 8, 2)}")


def read_line(stream) -> str:
    """MOVE SPACES TO WS-LINE, ACCEPT WS-LINE: one stdin line as PIC X(80);
    end of input leaves it all spaces (COBOL lines 45-46)."""
    raw = stream.readline()
    if not raw:
        return " " * 80
    text = raw.decode("latin-1").rstrip("\n").rstrip("\r")
    return pic_x(text, 80)


def main() -> int:
    """MAIN-PARA (COBOL lines 43-57): read until END or a blank line, print
    totals, exit 4 if any record was in error."""
    totals = Totals()
    out: list = []
    stream = sys.stdin.buffer
    while True:
        line = read_line(stream)
        if line == " " * 80 or line[0:3] == "END":
            break
        process_record(line, totals, out)
    print_totals(totals, out)
    sys.stdout.buffer.write(("\n".join(out) + "\n").encode("latin-1"))
    sys.stdout.flush()
    return 4 if totals.errors > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
