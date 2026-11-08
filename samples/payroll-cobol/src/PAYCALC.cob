      *================================================================
      * PAYCALC - WEEKLY PAYROLL CALCULATION (1987, REV 1994)
      * READS ONE EMPLOYEE PER LINE FROM STANDARD INPUT:
      *   COLS 1-5   EMPLOYEE ID
      *   COLS 6-8   HOURS WORKED, WHOLE HOURS 000-168
      *   COLS 9-13  HOURLY RATE IN CENTS (02550 = 25.50)
      * A LINE STARTING WITH END, OR A BLANK LINE, ENDS THE INPUT.
      * PRINTS ONE PAY LINE PER VALID EMPLOYEE, AN ERROR LINE PER
      * INVALID RECORD, THEN TOTALS. RETURN CODE 4 IF ANY ERRORS.
      *================================================================
       IDENTIFICATION DIVISION.
       PROGRAM-ID. PAYCALC.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-LINE                 PIC X(80).
       01  WS-REC REDEFINES WS-LINE.
           05  IN-ID               PIC X(5).
           05  IN-HOURS            PIC X(3).
           05  IN-RATE             PIC X(5).
           05  FILLER              PIC X(67).
       01  WS-HOURS                PIC 9(3).
       01  WS-RATE-CENTS           PIC 9(5).
       01  WS-RATE                 PIC 9(3)V99.
       01  WS-REG-HOURS            PIC 9(3).
       01  WS-OT-HOURS             PIC 9(3).
       01  WS-GROSS                PIC 9(7)V99.
       01  WS-TAX                  PIC 9(7)V99.
       01  WS-NET                  PIC 9(7)V99.
       01  WS-TOTAL-GROSS          PIC 9(9)V99 VALUE 0.
       01  WS-TOTAL-NET            PIC 9(9)V99 VALUE 0.
       01  WS-COUNT                PIC 9(5) VALUE 0.
       01  WS-ERRORS               PIC 9(5) VALUE 0.
       01  WS-DONE                 PIC X VALUE 'N'.
       01  WS-VALID                PIC X.
       01  OUT-GROSS               PIC Z(6)9.99.
       01  OUT-TAX                 PIC Z(6)9.99.
       01  OUT-NET                 PIC Z(6)9.99.
       01  OUT-TGROSS              PIC Z(8)9.99.
       01  OUT-TNET                PIC Z(8)9.99.
       01  OUT-COUNT               PIC Z(4)9.
       01  OUT-ERRORS              PIC Z(4)9.
       PROCEDURE DIVISION.
       MAIN-PARA.
           PERFORM UNTIL WS-DONE = 'Y'
               MOVE SPACES TO WS-LINE
               ACCEPT WS-LINE
               IF WS-LINE = SPACES OR WS-LINE(1:3) = 'END'
                   MOVE 'Y' TO WS-DONE
               ELSE
                   PERFORM PROCESS-RECORD
               END-IF
           END-PERFORM
           PERFORM PRINT-TOTALS
           IF WS-ERRORS > 0
               MOVE 4 TO RETURN-CODE
           END-IF
           STOP RUN.

       PROCESS-RECORD.
           MOVE 'Y' TO WS-VALID
           IF IN-ID = SPACES
               DISPLAY 'ERROR ----- MISSING EMPLOYEE ID'
               MOVE 'N' TO WS-VALID
           ELSE
               IF IN-HOURS IS NOT NUMERIC
                   DISPLAY 'ERROR ' IN-ID ' INVALID HOURS'
                   MOVE 'N' TO WS-VALID
               ELSE
                   MOVE IN-HOURS TO WS-HOURS
                   IF WS-HOURS > 168
                       DISPLAY 'ERROR ' IN-ID ' HOURS OVER 168'
                       MOVE 'N' TO WS-VALID
                   END-IF
               END-IF
               IF WS-VALID = 'Y'
                   IF IN-RATE IS NOT NUMERIC
                       DISPLAY 'ERROR ' IN-ID ' INVALID RATE'
                       MOVE 'N' TO WS-VALID
                   ELSE
                       MOVE IN-RATE TO WS-RATE-CENTS
                       IF WS-RATE-CENTS = 0
                           DISPLAY 'ERROR ' IN-ID ' ZERO RATE'
                           MOVE 'N' TO WS-VALID
                       END-IF
                   END-IF
               END-IF
           END-IF
           IF WS-VALID = 'N'
               ADD 1 TO WS-ERRORS
           ELSE
               PERFORM CALC-PAY
           END-IF.

       CALC-PAY.
           COMPUTE WS-RATE = WS-RATE-CENTS / 100
      *    OVERTIME: HOURS OVER 40 ARE PAID AT TIME AND A HALF
           IF WS-HOURS > 40
               MOVE 40 TO WS-REG-HOURS
               COMPUTE WS-OT-HOURS = WS-HOURS - 40
           ELSE
               MOVE WS-HOURS TO WS-REG-HOURS
               MOVE 0 TO WS-OT-HOURS
           END-IF
           COMPUTE WS-GROSS ROUNDED =
               (WS-REG-HOURS * WS-RATE)
             + (WS-OT-HOURS * WS-RATE * 1.5)
      *    TAX: 10% UP TO 500.00, 20% FROM 500.01 TO 1500.00,
      *    30% ABOVE 1500.00 (BRACKETS ARE MARGINAL)
           IF WS-GROSS <= 500
               COMPUTE WS-TAX ROUNDED = WS-GROSS * 0.10
           ELSE
               IF WS-GROSS <= 1500
                   COMPUTE WS-TAX ROUNDED =
                       50 + (WS-GROSS - 500) * 0.20
               ELSE
                   COMPUTE WS-TAX ROUNDED =
                       250 + (WS-GROSS - 1500) * 0.30
               END-IF
           END-IF
           COMPUTE WS-NET = WS-GROSS - WS-TAX
           ADD 1 TO WS-COUNT
           ADD WS-GROSS TO WS-TOTAL-GROSS
           ADD WS-NET TO WS-TOTAL-NET
           MOVE WS-GROSS TO OUT-GROSS
           MOVE WS-TAX TO OUT-TAX
           MOVE WS-NET TO OUT-NET
           DISPLAY 'PAY ' IN-ID ' GROSS ' OUT-GROSS
               ' TAX ' OUT-TAX ' NET ' OUT-NET.

       PRINT-TOTALS.
           MOVE WS-COUNT TO OUT-COUNT
           MOVE WS-ERRORS TO OUT-ERRORS
           MOVE WS-TOTAL-GROSS TO OUT-TGROSS
           MOVE WS-TOTAL-NET TO OUT-TNET
           DISPLAY 'EMPLOYEES ' OUT-COUNT ' ERRORS ' OUT-ERRORS
           DISPLAY 'TOTAL GROSS ' OUT-TGROSS ' TOTAL NET ' OUT-TNET.
