from flask_wtf import FlaskForm
from wtforms import (
    StringField, PasswordField, BooleanField, SubmitField, TextAreaField,
    SelectField, FloatField, IntegerField, DateField, HiddenField
)
from wtforms.validators import DataRequired, Email, Length, Optional, EqualTo


class LoginForm(FlaskForm):
    username = StringField("Username", validators=[DataRequired(), Length(3, 80)])
    password = PasswordField("Password", validators=[DataRequired()])
    remember = BooleanField("Remember me")
    submit = SubmitField("Sign in")


class RegisterForm(FlaskForm):
    username = StringField("Username", validators=[DataRequired(), Length(3, 80)])
    full_name = StringField("Full name", validators=[Optional(), Length(max=120)])
    email = StringField("Email", validators=[DataRequired(), Email()])
    password = PasswordField(
        "Password", validators=[DataRequired(), Length(min=6)]
    )
    confirm = PasswordField(
        "Confirm password",
        validators=[DataRequired(), EqualTo("password", "Passwords must match")],
    )
    submit = SubmitField("Create account")


class ClientForm(FlaskForm):
    name = StringField("Owner / Client name", validators=[DataRequired(), Length(max=200)])
    phone = StringField("Phone", validators=[Optional(), Length(max=60)])
    email = StringField("Email", validators=[Optional(), Email(), Length(max=120)])
    address = StringField("Address", validators=[Optional(), Length(max=300)])
    notes = TextAreaField("Notes", validators=[Optional()])
    submit = SubmitField("Save client")


class ArchitectForm(FlaskForm):
    name = StringField("Architect / Engineer name", validators=[DataRequired(), Length(max=200)])
    title = StringField("Title (e.g. Ar., Engr.)", validators=[Optional(), Length(max=80)])
    phone = StringField("Phone", validators=[Optional(), Length(max=60)])
    email = StringField("Email", validators=[Optional(), Email(), Length(max=120)])
    company_name = StringField("Company", validators=[Optional(), Length(max=200)])
    company_address = StringField("Company address", validators=[Optional(), Length(max=300)])
    notes = TextAreaField("Notes", validators=[Optional()])
    submit = SubmitField("Save architect")


class ProposalForm(FlaskForm):
    project_number = StringField("Project #", validators=[Optional(), Length(max=20)])
    date_received = DateField("Date received", validators=[Optional()])
    date_proposed = DateField("Date proposed", validators=[Optional()])

    project_title = StringField("Project title", validators=[DataRequired(), Length(max=300)])
    category = StringField("Category", validators=[Optional(), Length(max=200)])
    location = StringField("Location", validators=[Optional(), Length(max=300)])

    client_id = SelectField("Project owner (Client)", coerce=int, validators=[Optional()])
    architect_id = SelectField("Architect in charge", coerce=int, validators=[Optional()])

    lot_area_sqm = FloatField("Lot area (sqm)", validators=[Optional()])
    rate_per_sqm = FloatField("Rate per sqm", validators=[Optional()])
    sheet_count = IntegerField("Sheet count", validators=[Optional()])
    rate_per_sheet = FloatField("Rate per sheet", validators=[Optional()])
    price = FloatField("Total price", validators=[Optional()])
    price_approved = FloatField("Approved price", validators=[Optional()])
    payed = FloatField("Amount paid", validators=[Optional()])

    status = SelectField(
        "Status",
        choices=[
            ("Draft", "Draft"),
            ("Submitted", "Submitted"),
            ("Approved", "Approved"),
            ("Rejected", "Rejected"),
            ("Paid", "Paid"),
        ],
        default="Draft",
    )
    payment_method = StringField("Payment method", validators=[Optional(), Length(max=60)])
    date_approved = DateField("Date approved", validators=[Optional()])

    scope_of_work = TextAreaField("Scope of work")
    deliverables = TextAreaField("Deliverables")
    schedule_duration = StringField("Schedule / duration", validators=[Optional(), Length(max=200)])
    payment_terms = TextAreaField("Payment terms")
    remarks = TextAreaField("Remarks")

    submit = SubmitField("Save proposal")
